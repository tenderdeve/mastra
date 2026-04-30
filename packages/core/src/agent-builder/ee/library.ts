import type { BuilderLibraryConfig } from './types';

/**
 * Resolved Library visibility, returned alongside `BuilderSettingsResponse`.
 *
 * Mirrors the response shape so the client never has to disambiguate
 * `undefined` vs `[]`.
 */
export interface ResolvedLibraryVisibility {
  /** IDs that should appear in the Library. Filtered against the registry. */
  visibleAgents: string[];
  /** True when the admin omitted `visibleAgents` ⇒ show all eligible agents. */
  unrestricted: boolean;
  /** Non-fatal warnings (e.g. unknown agent IDs in the allowlist). */
  warnings: string[];
}

export interface ResolveLibraryVisibilityInputs {
  /** The `library` slice of `AgentBuilderOptions['configuration']`. */
  config: BuilderLibraryConfig | undefined;
  /** All agent IDs currently registered with the Mastra instance. */
  registeredAgentIds: readonly string[];
}

/**
 * Pure derivation of {@link ResolvedLibraryVisibility} from admin config and
 * the registered agent set.
 *
 * - `config` undefined or `visibleAgents` undefined ⇒ unrestricted, no warnings.
 * - `visibleAgents` provided ⇒ filter to known IDs; emit one warning per
 *   unknown ID; `unrestricted` is `false`.
 *
 * Stable order: returned `visibleAgents` preserves the admin-provided order
 * with unknowns dropped. Duplicates are de-duplicated.
 */
export function resolveLibraryVisibility({
  config,
  registeredAgentIds,
}: ResolveLibraryVisibilityInputs): ResolvedLibraryVisibility {
  const allowlist = config?.visibleAgents;
  if (allowlist === undefined) {
    return { visibleAgents: [], unrestricted: true, warnings: [] };
  }

  const known = new Set(registeredAgentIds);
  const seen = new Set<string>();
  const visibleAgents: string[] = [];
  const warnings: string[] = [];

  for (const id of allowlist) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (known.has(id)) {
      visibleAgents.push(id);
    } else {
      warnings.push(
        `library.visibleAgents references unknown agent "${id}" — no agent with this ID is registered. It will be hidden from the Library.`,
      );
    }
  }

  return { visibleAgents, unrestricted: false, warnings };
}
