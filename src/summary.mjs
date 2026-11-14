export function summarize(bytes, mediaType) {
  if (mediaType.includes('application/json')) {
    try {
      const value = JSON.parse(bytes);
      if (value.deliveryId && Array.isArray(value.roots)) return { format: 'delivery-index', deliveryId: value.deliveryId, roots: value.roots.length };
    } catch {}
  }
  return { format: 'pgn', events: [...bytes.toString('utf8').matchAll(/\[Event "([^"]*)"\]/g)].map(match => match[1]), byteLength: bytes.length };
}
