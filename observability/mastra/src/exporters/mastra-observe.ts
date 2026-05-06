import { ErrorCategory, ErrorDomain, MastraError } from '@mastra/core/error';
import { LogLevel } from '@mastra/core/logger';
import { SpanType, TracingEventType } from '@mastra/core/observability';
import type {
  TracingEvent,
  AnyExportedSpan,
  LogEvent,
  MetricEvent,
  ScoreEvent,
  FeedbackEvent,
} from '@mastra/core/observability';
import { fetchWithRetry } from '@mastra/core/utils';
import { BaseExporter } from './base';
import type { BaseExporterConfig } from './base';

export interface MastraObserveExporterConfig extends BaseExporterConfig {
  maxBatchSize?: number; // Default: 1000 spans
  maxBatchWaitMs?: number; // Default: 5000ms
  maxRetries?: number; // Default: 3

  accessToken?: string; // Mastra Observability access token (from env or config)
  projectId?: string; // Project ID for project-scoped collector routes
  endpoint?: string; // Base observability endpoint
  tracesEndpoint?: string; // Explicit traces endpoint override
  logsEndpoint?: string; // Explicit logs endpoint override
  metricsEndpoint?: string; // Explicit metrics endpoint override
  scoresEndpoint?: string; // Explicit scores endpoint override
  feedbackEndpoint?: string; // Explicit feedback endpoint override
}

type ObserveSignal = 'traces' | 'logs' | 'metrics' | 'scores' | 'feedback';

const SIGNAL_PUBLISH_SUFFIXES: Record<ObserveSignal, string> = {
  traces: '/spans/publish',
  logs: '/logs/publish',
  metrics: '/metrics/publish',
  scores: '/scores/publish',
  feedback: '/feedback/publish',
};

const DEFAULT_OBSERVE_SPAN_FILTER = (span: AnyExportedSpan): boolean => span.type !== SpanType.MODEL_CHUNK;

const SIGNAL_PUBLISH_SEGMENTS: Record<ObserveSignal, string> = {
  traces: 'spans',
  logs: 'logs',
  metrics: 'metrics',
  scores: 'scores',
  feedback: 'feedback',
};

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end--;
  }
  return end === value.length ? value : value.slice(0, end);
}

function createInvalidEndpointError(endpoint: string, text: string, cause?: unknown): MastraError {
  return new MastraError(
    {
      id: `MASTRA_OBSERVE_EXPORTER_INVALID_ENDPOINT`,
      text,
      domain: ErrorDomain.MASTRA_OBSERVABILITY,
      category: ErrorCategory.USER,
      details: {
        endpoint,
      },
    },
    cause,
  );
}

const VALID_PROJECT_ID = /^[a-zA-Z0-9_-]+$/;

function createInvalidProjectIdError(projectId: string): MastraError {
  return new MastraError({
    id: `MASTRA_OBSERVE_EXPORTER_INVALID_PROJECT_ID`,
    text: 'MastraObserveExporter projectId must only contain letters, numbers, hyphens, and underscores.',
    domain: ErrorDomain.MASTRA_OBSERVABILITY,
    category: ErrorCategory.USER,
    details: {
      projectId,
    },
  });
}

function resolveBaseEndpoint(baseEndpoint: string): string {
  const normalizedEndpoint = trimTrailingSlashes(baseEndpoint);
  const invalidText =
    'MastraObserveExporter endpoint must be a base origin like "https://collector.example.com" with no path, search, or hash.';

  try {
    const parsedEndpoint = new URL(normalizedEndpoint);
    if (parsedEndpoint.pathname !== '/' || parsedEndpoint.search || parsedEndpoint.hash) {
      throw createInvalidEndpointError(baseEndpoint, invalidText);
    }
    return trimTrailingSlashes(parsedEndpoint.origin);
  } catch (error) {
    if (error instanceof MastraError) {
      throw error;
    }

    throw createInvalidEndpointError(baseEndpoint, invalidText, error);
  }
}

function buildSignalPath(signal: ObserveSignal, projectId?: string): string {
  const signalSegment = SIGNAL_PUBLISH_SEGMENTS[signal];
  if (!projectId) {
    return `/ai/${signalSegment}/publish`;
  }

  return `/projects/${projectId}/ai/${signalSegment}/publish`;
}

function buildSignalEndpoint(baseEndpoint: string, signal: ObserveSignal, projectId?: string): string {
  return `${baseEndpoint}${buildSignalPath(signal, projectId)}`;
}

function resolveExplicitSignalEndpoint(signal: ObserveSignal, endpoint: string, projectId?: string): string {
  const normalizedEndpoint = trimTrailingSlashes(endpoint);
  const invalidText = `MastraObserveExporter ${signal}Endpoint must be a base origin like "https://collector.example.com" or a full ${signal} publish URL ending in "${SIGNAL_PUBLISH_SUFFIXES[signal]}".`;

  try {
    const parsedEndpoint = new URL(normalizedEndpoint);
    if (parsedEndpoint.search || parsedEndpoint.hash) {
      throw createInvalidEndpointError(endpoint, invalidText);
    }

    const normalizedOrigin = trimTrailingSlashes(parsedEndpoint.origin);
    const normalizedPathname = trimTrailingSlashes(parsedEndpoint.pathname);

    if (!normalizedPathname || normalizedPathname === '/') {
      return buildSignalEndpoint(normalizedOrigin, signal, projectId);
    }

    if (normalizedPathname.endsWith(SIGNAL_PUBLISH_SUFFIXES[signal])) {
      return `${normalizedOrigin}${normalizedPathname}`;
    }

    throw createInvalidEndpointError(endpoint, invalidText);
  } catch (error) {
    if (error instanceof MastraError) {
      throw error;
    }

    throw createInvalidEndpointError(endpoint, invalidText, error);
  }
}

function deriveSignalEndpointFromTracesEndpoint(signal: ObserveSignal, tracesEndpoint: string): string {
  if (signal === 'traces') {
    return tracesEndpoint;
  }

  const normalizedTracesEndpoint = trimTrailingSlashes(tracesEndpoint);
  const invalidText =
    'MastraObserveExporter tracesEndpoint must be a base origin like "https://collector.example.com" or a full traces publish URL ending in "/spans/publish".';

  try {
    const parsedEndpoint = new URL(normalizedTracesEndpoint);
    const normalizedOrigin = trimTrailingSlashes(parsedEndpoint.origin);
    const normalizedPathname = trimTrailingSlashes(parsedEndpoint.pathname);

    if (!normalizedPathname.endsWith(SIGNAL_PUBLISH_SUFFIXES.traces)) {
      throw createInvalidEndpointError(tracesEndpoint, invalidText);
    }

    const basePath = normalizedPathname.slice(0, -SIGNAL_PUBLISH_SUFFIXES.traces.length);
    return `${normalizedOrigin}${basePath}${SIGNAL_PUBLISH_SUFFIXES[signal]}`;
  } catch (error) {
    if (error instanceof MastraError) {
      throw error;
    }

    throw createInvalidEndpointError(tracesEndpoint, invalidText, error);
  }
}

interface MastraObserveBuffer {
  spans: MastraObserveSpanRecord[];
  logs: MastraObserveLogRecord[];
  metrics: MastraObserveMetricRecord[];
  scores: MastraObserveScoreRecord[];
  feedback: MastraObserveFeedbackRecord[];
  firstEventTime?: Date;
  totalSize: number;
}

type MastraObserveSpanRecord = AnyExportedSpan & {
  spanId: string;
  spanType: string;
  startedAt: Date;
  endedAt: Date | null;
  error: AnyExportedSpan['errorInfo'] | null;
  createdAt: Date;
  updatedAt: Date | null;
};

type MastraObserveLogRecord = LogEvent['log'];
type MastraObserveMetricRecord = MetricEvent['metric'];
type MastraObserveScoreRecord = ScoreEvent['score'];
type MastraObserveFeedbackRecord = FeedbackEvent['feedback'];

type ResolvedObserveConfig = {
  logger: BaseExporterConfig['logger'];
  logLevel: NonNullable<BaseExporterConfig['logLevel']>;
  maxBatchSize: number;
  maxBatchWaitMs: number;
  maxRetries: number;
  accessToken: string;
  tracesEndpoint: string;
  logsEndpoint: string;
  metricsEndpoint: string;
  scoresEndpoint: string;
  feedbackEndpoint: string;
};

export class MastraObserveExporter extends BaseExporter {
  name = 'mastra-observe-exporter';

  private readonly observeConfig: Readonly<ResolvedObserveConfig>;
  private buffer: MastraObserveBuffer;
  private flushTimer: NodeJS.Timeout | null = null;
  private inFlightFlushes = new Set<Promise<void>>();

  constructor(config: MastraObserveExporterConfig = {}) {
    super(config);

    if (config.projectId !== undefined && !VALID_PROJECT_ID.test(config.projectId)) {
      throw createInvalidProjectIdError(config.projectId);
    }

    const accessToken = config.accessToken ?? process.env.MASTRA_CLOUD_ACCESS_TOKEN;
    // Treat an empty MASTRA_PROJECT_ID as unset so deployments that always
    // export the variable (e.g. CI templates) don't have to special-case it.
    const envProjectId = process.env.MASTRA_PROJECT_ID === '' ? undefined : process.env.MASTRA_PROJECT_ID;
    const rawProjectId = config.projectId ?? envProjectId;
    if (rawProjectId !== undefined && !VALID_PROJECT_ID.test(rawProjectId)) {
      throw createInvalidProjectIdError(rawProjectId);
    }
    const projectId = rawProjectId;
    if (!accessToken) {
      this.setDisabled('MASTRA_CLOUD_ACCESS_TOKEN environment variable not set.', 'debug');
    }

    const tracesEndpointOverride = config.tracesEndpoint ?? process.env.MASTRA_CLOUD_TRACES_ENDPOINT;
    let baseEndpoint: string | undefined;
    let tracesEndpoint: string;

    if (tracesEndpointOverride) {
      tracesEndpoint = resolveExplicitSignalEndpoint('traces', tracesEndpointOverride, projectId);
    } else {
      baseEndpoint = resolveBaseEndpoint(config.endpoint ?? 'https://observability.mastra.ai');
      tracesEndpoint = buildSignalEndpoint(baseEndpoint, 'traces', projectId);
    }

    const resolveConfiguredSignalEndpoint = (
      signal: Exclude<ObserveSignal, 'traces'>,
      explicitEndpoint?: string,
    ): string => {
      if (explicitEndpoint) {
        return resolveExplicitSignalEndpoint(signal, explicitEndpoint, projectId);
      }

      if (tracesEndpointOverride) {
        return deriveSignalEndpointFromTracesEndpoint(signal, tracesEndpoint);
      }

      return buildSignalEndpoint(baseEndpoint!, signal, projectId);
    };

    this.observeConfig = {
      logger: this.logger,
      logLevel: config.logLevel ?? LogLevel.INFO,
      maxBatchSize: config.maxBatchSize ?? 1000,
      maxBatchWaitMs: config.maxBatchWaitMs ?? 5000,
      maxRetries: config.maxRetries ?? 3,
      accessToken: accessToken || '',
      tracesEndpoint,
      logsEndpoint: resolveConfiguredSignalEndpoint('logs', config.logsEndpoint),
      metricsEndpoint: resolveConfiguredSignalEndpoint('metrics', config.metricsEndpoint),
      scoresEndpoint: resolveConfiguredSignalEndpoint('scores', config.scoresEndpoint),
      feedbackEndpoint: resolveConfiguredSignalEndpoint('feedback', config.feedbackEndpoint),
    };

    this.buffer = {
      spans: [],
      logs: [],
      metrics: [],
      scores: [],
      feedback: [],
      totalSize: 0,
    };
  }

  protected async _exportTracingEvent(event: TracingEvent): Promise<void> {
    if (event.type !== TracingEventType.SPAN_ENDED) {
      return;
    }

    if (!DEFAULT_OBSERVE_SPAN_FILTER(event.exportedSpan)) {
      return;
    }

    this.addToBuffer(event);

    await this.handleBufferedEvent();
  }

  async onLogEvent(event: LogEvent): Promise<void> {
    if (this.isDisabled) {
      return;
    }

    this.addLogToBuffer(event);
    await this.handleBufferedEvent();
  }

  async onMetricEvent(event: MetricEvent): Promise<void> {
    if (this.isDisabled) {
      return;
    }

    this.addMetricToBuffer(event);
    await this.handleBufferedEvent();
  }

  async onScoreEvent(event: ScoreEvent): Promise<void> {
    if (this.isDisabled) {
      return;
    }

    this.addScoreToBuffer(event);
    await this.handleBufferedEvent();
  }

  async onFeedbackEvent(event: FeedbackEvent): Promise<void> {
    if (this.isDisabled) {
      return;
    }

    this.addFeedbackToBuffer(event);
    await this.handleBufferedEvent();
  }

  private addToBuffer(event: TracingEvent): void {
    this.markBufferStart();

    const spanRecord = this.formatSpan(event.exportedSpan);
    this.buffer.spans.push(spanRecord);
    this.buffer.totalSize++;
  }

  private addLogToBuffer(event: LogEvent): void {
    this.markBufferStart();

    this.buffer.logs.push(this.formatLog(event.log));
    this.buffer.totalSize++;
  }

  private addMetricToBuffer(event: MetricEvent): void {
    this.markBufferStart();

    this.buffer.metrics.push(this.formatMetric(event.metric));
    this.buffer.totalSize++;
  }

  private addScoreToBuffer(event: ScoreEvent): void {
    this.markBufferStart();

    this.buffer.scores.push(this.formatScore(event.score));
    this.buffer.totalSize++;
  }

  private addFeedbackToBuffer(event: FeedbackEvent): void {
    this.markBufferStart();

    this.buffer.feedback.push(this.formatFeedback(event.feedback));
    this.buffer.totalSize++;
  }

  private markBufferStart(): void {
    if (this.buffer.totalSize === 0) {
      this.buffer.firstEventTime = new Date();
    }
  }

  private formatSpan(span: AnyExportedSpan): MastraObserveSpanRecord {
    const spanRecord: MastraObserveSpanRecord = {
      ...span,
      spanId: span.id,
      spanType: span.type,
      startedAt: span.startTime,
      endedAt: span.endTime ?? null,
      error: span.errorInfo ?? null,
      createdAt: new Date(),
      updatedAt: null,
    };

    return spanRecord;
  }

  private formatLog(log: LogEvent['log']): MastraObserveLogRecord {
    return {
      ...log,
    };
  }

  private formatMetric(metric: MetricEvent['metric']): MastraObserveMetricRecord {
    return {
      ...metric,
    };
  }

  private formatScore(score: ScoreEvent['score']): MastraObserveScoreRecord {
    return {
      ...score,
    };
  }

  private formatFeedback(feedback: FeedbackEvent['feedback']): MastraObserveFeedbackRecord {
    return {
      ...feedback,
    };
  }

  private async handleBufferedEvent(): Promise<void> {
    if (this.shouldFlush()) {
      void this.flush().catch(error => {
        this.logger.error('Batch flush failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    } else if (this.buffer.totalSize === 1) {
      this.scheduleFlush();
    }
  }

  private shouldFlush(): boolean {
    if (this.buffer.totalSize >= this.observeConfig.maxBatchSize) {
      return true;
    }

    if (this.buffer.firstEventTime && this.buffer.totalSize > 0) {
      const elapsed = Date.now() - this.buffer.firstEventTime.getTime();
      if (elapsed >= this.observeConfig.maxBatchWaitMs) {
        return true;
      }
    }

    return false;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => {
      void this.flush().catch(error => {
        const mastraError = new MastraError(
          {
            id: `MASTRA_OBSERVE_EXPORTER_FAILED_TO_SCHEDULE_FLUSH`,
            domain: ErrorDomain.MASTRA_OBSERVABILITY,
            category: ErrorCategory.USER,
          },
          error,
        );
        this.logger.trackException(mastraError);
        this.logger.error('Scheduled flush failed', mastraError);
      });
    }, this.observeConfig.maxBatchWaitMs);
  }

  private async flushBuffer(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.buffer.totalSize === 0) {
      return;
    }

    const startTime = Date.now();
    const spansCopy = [...this.buffer.spans];
    const logsCopy = [...this.buffer.logs];
    const metricsCopy = [...this.buffer.metrics];
    const scoresCopy = [...this.buffer.scores];
    const feedbackCopy = [...this.buffer.feedback];
    const batchSize = this.buffer.totalSize;
    const flushReason = this.buffer.totalSize >= this.observeConfig.maxBatchSize ? 'size' : 'time';

    this.resetBuffer();

    const results = await Promise.all([
      this.flushSignalBatch('traces', spansCopy),
      this.flushSignalBatch('logs', logsCopy),
      this.flushSignalBatch('metrics', metricsCopy),
      this.flushSignalBatch('scores', scoresCopy),
      this.flushSignalBatch('feedback', feedbackCopy),
    ]);

    const failedSignals = results.filter(result => !result.succeeded).map(result => result.signal);

    const elapsed = Date.now() - startTime;

    if (failedSignals.length === 0) {
      this.logger.debug('Batch flushed successfully', {
        batchSize,
        flushReason,
        durationMs: elapsed,
      });
      return;
    }

    this.logger.warn('Batch flush completed with dropped signal batches', {
      batchSize,
      flushReason,
      durationMs: elapsed,
      failedSignals,
    });
  }

  /**
   * Uploads a signal batch to the configured Mastra Observability API using fetchWithRetry.
   */
  private async batchUpload<T>(signal: ObserveSignal, records: T[]): Promise<void> {
    const headers = {
      Authorization: `Bearer ${this.observeConfig.accessToken}`,
      'Content-Type': 'application/json',
    };

    const endpointMap: Record<ObserveSignal, string> = {
      traces: this.observeConfig.tracesEndpoint,
      logs: this.observeConfig.logsEndpoint,
      metrics: this.observeConfig.metricsEndpoint,
      scores: this.observeConfig.scoresEndpoint,
      feedback: this.observeConfig.feedbackEndpoint,
    };

    const options: RequestInit = {
      method: 'POST',
      headers,
      body: JSON.stringify({ [SIGNAL_PUBLISH_SEGMENTS[signal]]: records }),
    };

    await fetchWithRetry(endpointMap[signal], options, this.observeConfig.maxRetries);
  }

  private async flushSignalBatch<T>(
    signal: ObserveSignal,
    records: T[],
  ): Promise<{ signal: ObserveSignal; succeeded: boolean }> {
    if (records.length === 0) {
      return { signal, succeeded: true };
    }

    try {
      await this.batchUpload(signal, records);
      return { signal, succeeded: true };
    } catch (error) {
      const errorId = `MASTRA_OBSERVE_EXPORTER_FAILED_TO_BATCH_UPLOAD_${signal.toUpperCase()}` as Uppercase<string>;
      const mastraError = new MastraError(
        {
          id: errorId,
          domain: ErrorDomain.MASTRA_OBSERVABILITY,
          category: ErrorCategory.USER,
          details: {
            signal,
            droppedBatchSize: records.length,
          },
        },
        error,
      );
      this.logger.trackException(mastraError);
      this.logger.error('Batch upload failed after all retries, dropping batch', mastraError);
      return { signal, succeeded: false };
    }
  }

  private resetBuffer(): void {
    this.buffer.spans = [];
    this.buffer.logs = [];
    this.buffer.metrics = [];
    this.buffer.scores = [];
    this.buffer.feedback = [];
    this.buffer.firstEventTime = undefined;
    this.buffer.totalSize = 0;
  }

  /**
   * Force flush any buffered events without shutting down the exporter.
   * This is useful in serverless environments where you need to ensure events
   * are exported before the runtime instance is terminated.
   */
  async flush(): Promise<void> {
    if (this.isDisabled) {
      return;
    }

    while (this.buffer.totalSize > 0 || this.inFlightFlushes.size > 0) {
      if (this.buffer.totalSize > 0) {
        this.logger.debug('Flushing buffered events', {
          bufferedEvents: this.buffer.totalSize,
        });

        const flushPromise = this.flushBuffer();
        this.inFlightFlushes.add(flushPromise);

        try {
          await flushPromise;
        } finally {
          this.inFlightFlushes.delete(flushPromise);
        }

        continue;
      }

      await Promise.allSettled([...this.inFlightFlushes]);
    }
  }

  async shutdown(): Promise<void> {
    if (this.isDisabled) {
      return;
    }

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    try {
      await this.flush();
    } catch (error) {
      const mastraError = new MastraError(
        {
          id: `MASTRA_OBSERVE_EXPORTER_FAILED_TO_FLUSH_REMAINING_EVENTS_DURING_SHUTDOWN`,
          domain: ErrorDomain.MASTRA_OBSERVABILITY,
          category: ErrorCategory.USER,
          details: {
            remainingEvents: this.buffer.totalSize,
          },
        },
        error,
      );

      this.logger.trackException(mastraError);
      this.logger.error('Failed to flush remaining events during shutdown', mastraError);
    }

    this.logger.info('MastraObserveExporter shutdown complete');
  }
}
