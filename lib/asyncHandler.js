'use strict';

// Express 4 does not automatically forward rejected route promises to error
// middleware. Keep async handlers concise while preserving the normal `next`
// error path.
module.exports = function asyncHandler(handler) {
  return function wrappedAsyncHandler(req, res, next) {
    return Promise.resolve(handler(req, res, next)).catch(next);
  };
};
