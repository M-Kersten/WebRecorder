'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Scratch directories, and getting rid of them afterwards.
 *
 * Removing one is less trivial than it looks on Windows. A browser or an ffmpeg
 * child that has just exited can still hold a handle inside for a moment, and
 * indexers and virus scanners open files behind your back, so the delete comes
 * back EPERM. Node retries on exactly those errors when asked to, so ask.
 *
 * More importantly, cleanup must never be able to fail the run. Leaving a few
 * megabytes in the temp folder costs nothing; reporting a finished video as an
 * error because the folder it was built in would not delete costs the user
 * their video.
 */

function createWorkDir(prefix = 'tutvid-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Delete a directory. Returns whether it went, and never throws.
 * `log` hears about it only when it did not.
 */
function removeWorkDir(dir, log = () => {}) {
  if (!dir) return true;
  try {
    fs.rmSync(dir, {
      recursive: true,
      force: true,
      // Covers EBUSY, ENOTEMPTY, EPERM and friends: about a second and a half
      // of waiting for whatever still has the folder open to let go.
      maxRetries: 10,
      retryDelay: 150,
    });
    return true;
  } catch (err) {
    log(`could not clean up ${dir} (${err.code || err.message}); it can be deleted by hand`);
    return false;
  }
}

module.exports = { createWorkDir, removeWorkDir };
