import { createPrivateKey } from 'node:crypto';
import type { AgentCard, AgentCardSignature } from '@mastra/core/a2a';
import type { A2AAgentCardSigningConfig } from '@mastra/core/server';
import canonicalize from 'canonicalize';
import jws from 'jws';
import type { Algorithm, Header } from 'jws';

const SUPPORTED_JWS_ALGORITHMS = new Set<string>(jws.ALGORITHMS);

function stripAgentCardSignatures(agentCard: AgentCard): AgentCard {
  const unsignedCard = structuredClone(agentCard) as AgentCard & { signatures?: AgentCardSignature[] };
  delete unsignedCard.signatures;
  return unsignedCard;
}

function importSigningKey(signing: A2AAgentCardSigningConfig) {
  const { privateKey } = signing;

  if (typeof privateKey === 'string') {
    return createPrivateKey(privateKey);
  }

  return createPrivateKey({
    key: privateKey,
    format: 'jwk',
  });
}

function getProtectedHeader(signing: A2AAgentCardSigningConfig): Header {
  const { alg, ...rest } = signing.protectedHeader;

  if (!SUPPORTED_JWS_ALGORITHMS.has(alg)) {
    throw new Error(`Unsupported JWS algorithm for A2A Agent Card signing: ${alg}`);
  }

  return {
    ...rest,
    alg: alg as Algorithm,
  };
}

export async function signAgentCard({
  agentCard,
  signing,
}: {
  agentCard: AgentCard;
  signing: A2AAgentCardSigningConfig;
}): Promise<AgentCard> {
  const canonicalPayload = canonicalize(stripAgentCardSignatures(agentCard));

  if (!canonicalPayload) {
    throw new Error('Failed to canonicalize A2A Agent Card for signing');
  }

  const key = importSigningKey(signing);
  const compactJws = jws.sign({
    header: getProtectedHeader(signing),
    payload: canonicalPayload,
    privateKey: key,
    encoding: 'utf8',
  });
  const [protectedHeader, , signatureValue] = compactJws.split('.');

  if (!protectedHeader || !signatureValue) {
    throw new Error('Failed to create compact JWS for A2A Agent Card');
  }

  const signature: AgentCardSignature = {
    protected: protectedHeader,
    signature: signatureValue,
    header: signing.header,
  };

  return {
    ...agentCard,
    signatures: [...(agentCard.signatures ?? []), signature],
  };
}
