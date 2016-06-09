var log = require('winston');
var async = require('async');
var fs = require('fs');
var path = require('path');
var readdirp = require('readdirp');
var archiver = require('archiver');

module.exports = function(params, callback) {
  params.zipFile = path.join(params.workingDir, params.versionLabel + '.zip');
  log.info('generating zip archive %s', params.zipFile);

  var erroredOut = false;
  var zipStream = fs.createWriteStream(params.zipFile);
  var archive = archiver('zip');

  // Make sure we don't include the zip file itself and other common files that
  // are safe to not deploy.
  var fileFilters = ['!' + params.versionLabel + '.zip', '!README.md', '!LICENSE.txt'];
  var directoryFilters = [];

  async.series([
    function(cb) {
      fs.readFile(path.join(params.workingDir, '.ebignore'), function(err, ebIgnore) {
        if (err) {
          if (err.code === 'ENOENT') {
            return cb(new Error('No .ebignore file found'));
          }
          return cb(err);
        }
        // Read in the .ebinclude patterns
        var globPatterns = ebIgnore.toString().split('\n');
        globPatterns.forEach(function(pattern) {
          // TODO: Disallow negation patterns in .ebignore
          // Force all patterns to be negation patterns
          // Directory filter patterns must end in a slash
          if (pattern.slice(-1) === '/') {
            directoryFilters.push('!' + pattern.slice(0, -1));
          } else {
            fileFilters.push('!' + pattern);
          }
        });

        cb();
      });
    },
    function(cb) {
      readdirp({
        root: params.workingDir,
        fileFilter: fileFilters,
        directoryFilter: directoryFilters
      })
      .on('data', function(entry) {
        // Don't include the original package.json
        if (entry.path === '/package.json') return;

        // Add the file to the zip archive
        log.debug('writing entry %s to archive', entry.path);
        archive.file(entry.fullPath, {name: entry.path});
      })
      .on('error', function(err) {
        erroredOut = true;
        return cb(err);
      })
      .on('end', function() {
        log.debug('finalizing archive');
        archive.finalize();
      });

      zipStream.on('close', function() {
        log.debug('done writing to zip archive');
        cb();
      });

      archive.on('error', function(err) {
        log.error('archiver error: %s', err.message);
        if (erroredOut !== true) {
          erroredOut = true;
          return cb(err);
        }
      });

      archive.pipe(zipStream);
    }
  ], callback);
};
