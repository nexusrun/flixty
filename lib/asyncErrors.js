import Layer from 'express/lib/router/layer.js'

// Express 4 only catches errors thrown synchronously by a route handler. An
// async handler that rejects (a failed DB query, a bad JSON.parse, a provider
// error) becomes an unhandled promise rejection instead — the request hangs,
// and on Node 15+ the whole process exits. This forwards a rejected promise to
// next(err) so the error handler in server.js answers it, which is what
// Express 5 does natively. Import this before any router is created.
Layer.prototype.handle_request = function handle(req, res, next) {
  const fn = this.handle
  if (fn.length > 3) return next() // error-handling middleware, not a request handler

  try {
    const ret = fn(req, res, next)
    if (ret && typeof ret.catch === 'function') ret.catch(next)
  } catch (err) {
    next(err)
  }
}
