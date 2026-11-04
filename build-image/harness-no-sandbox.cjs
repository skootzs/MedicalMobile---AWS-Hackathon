// Preloaded with node --require. Makes every cht-conf-test-harness launch Chromium with
// --no-sandbox, whichever package creates the harness, because neither R5's specs nor R6's
// verifier pass launch args. See docs/decisions.md for why the stage runs this way.
const Module = require('node:module');

const originalLoad = Module._load;
const patched = new WeakSet();

function addNoSandbox(harnessModule) {
  const Harness = harnessModule.default ?? harnessModule;
  const start = Harness?.prototype?.start;
  if (typeof start !== 'function') {
    throw new Error('cht-conf-test-harness has no start() to patch, so Chromium would launch with its sandbox on');
  }
  Harness.prototype.start = function startWithoutSandbox(...args) {
    const launchArgs = this.options.args ?? [];
    this.options.args = launchArgs.includes('--no-sandbox') ? launchArgs : [...launchArgs, '--no-sandbox'];
    return start.apply(this, args);
  };
}

Module._load = function loadAndPatch(request, ...rest) {
  const loaded = originalLoad.call(this, request, ...rest);
  if (request === 'cht-conf-test-harness' && !patched.has(loaded)) {
    addNoSandbox(loaded);
    patched.add(loaded);
  }
  return loaded;
};
