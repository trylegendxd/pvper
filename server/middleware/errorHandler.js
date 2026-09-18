// Keep unexpected infrastructure errors in server logs, not API responses.
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'payload_too_large' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid_json' });
  }
  if (Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ error: err.message });
  }

  console.error('[http] request failed', err);
  return res.status(500).json({ error: 'internal_error' });
}

module.exports = errorHandler;
