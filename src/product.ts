export const RESOURCE_URI_SCHEME = 'semantic-search';
export const RESOURCE_URI_HOST = 'indexes';
export const DEFAULT_INDEX_ID = 'default';

export function buildIndexBaseUri(indexId = DEFAULT_INDEX_ID): string {
  return `${RESOURCE_URI_SCHEME}://${RESOURCE_URI_HOST}/${encodeURIComponent(indexId)}`;
}

export function buildDocumentResourceUri(documentId: string, indexId = DEFAULT_INDEX_ID): string {
  return `${buildIndexBaseUri(indexId)}/documents/${encodeURIComponent(documentId)}`;
}

export const INDEX_MANIFEST_URI = `${buildIndexBaseUri()}/manifest`;
export const INDEX_STATS_URI = `${buildIndexBaseUri()}/stats`;
export const DOCUMENT_RESOURCE_TEMPLATE_URI = `${RESOURCE_URI_SCHEME}://${RESOURCE_URI_HOST}/{indexId}/documents/{documentId}`;
export const REGISTERED_RESOURCE_URIS = [INDEX_MANIFEST_URI, INDEX_STATS_URI] as const;
