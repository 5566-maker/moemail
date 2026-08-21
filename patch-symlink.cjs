const fs = require('fs');
const path = require('path');

const origSymlink = fs.symlink;
const origSymlinkSync = fs.symlinkSync;
const origPromisesSymlink = fs.promises.symlink;

function copyFallbackSync(target, p) {
  try {
    const absTarget = path.resolve(path.dirname(p), target);
    if (fs.existsSync(absTarget)) {
      const stat = fs.statSync(absTarget);
      if (stat.isDirectory()) {
        fs.mkdirSync(p, { recursive: true });
        fs.cpSync(absTarget, p, { recursive: true });
      } else {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.copyFileSync(absTarget, p);
      }
    }
  } catch (err) {}
}

fs.symlink = function(target, p, type, cb) {
  if (typeof type === 'function') {
    cb = type;
    type = null;
  }
  origSymlink(target, p, type, (err) => {
    if (err && (err.code === 'EPERM' || err.code === 'EACCES')) {
      copyFallbackSync(target, p);
      return cb ? cb(null) : undefined;
    }
    return cb ? cb(err) : undefined;
  });
};

fs.symlinkSync = function(target, p, type) {
  try {
    return origSymlinkSync(target, p, type);
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') {
      return copyFallbackSync(target, p);
    }
    throw e;
  }
};

fs.promises.symlink = async function(target, p, type) {
  try {
    return await origPromisesSymlink(target, p, type);
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') {
      return copyFallbackSync(target, p);
    }
    throw e;
  }
};