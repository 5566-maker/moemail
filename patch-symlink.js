const fs = require('fs');
const path = require('path');

const origSymlinkSync = fs.symlinkSync;
const origSymlink = fs.promises.symlink;

function copyFallback(target, p) {
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
}

fs.symlinkSync = function(target, p, type) {
  try {
    return origSymlinkSync(target, p, type);
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') {
      return copyFallback(target, p);
    }
    throw e;
  }
};

fs.promises.symlink = async function(target, p, type) {
  try {
    return await origSymlink(target, p, type);
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') {
      return copyFallback(target, p);
    }
    throw e;
  }
};

console.log('✅ Symlink patch loaded for Windows build');