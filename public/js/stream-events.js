(function (root) {
  'use strict';

  // The admin endpoints emit one JSON data line per event. EOF is not success.
  async function* readEvents(response) {
    if (!response.ok) throw new Error(`API error ${response.status}`);
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
      throw new Error('Flux SSE attendu');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', finalEvent = null, itemErrors = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        if (done && buffer) { lines.push(buffer); buffer = ''; }
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const event = JSON.parse(line.slice(5));
          if (event.status === 'error') {
            let message = event.error || event.line || 'Operation en erreur';
            if (event.partial || event.recovery_required) message += ' (etat partiel ou incertain : verification serveur requise)';
            if (event.operation_id) message += ` [operation ${event.operation_id}]`;
            throw new Error(message);
          }
          if (event.cancelled) throw new Error('Operation annulee');
          if (event.status === 'error_item' || event.error) itemErrors++;
          if (event.status === 'done') {
            finalEvent = event;
            const errors = Array.isArray(event.errors) ? event.errors.length : Number(event.errors) || 0;
            if (errors || itemErrors) throw new Error(`Operation partielle : ${Math.max(errors, itemErrors)} erreur(s)`);
          }
          if (event.status !== 'done') yield event;
        }
        if (done) break;
      }
      if (!finalEvent) throw new Error('Flux interrompu sans resultat final');
      yield finalEvent;
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  if (typeof module === 'object' && module.exports) module.exports = { readEvents };
  if (root) root.XflixStreams = { readEvents };
})(typeof window !== 'undefined' ? window : null);
