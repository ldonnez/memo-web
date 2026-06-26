import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { onUpdateAvailable, applyUpdate } from '../lib/update.js';

const mockNavigator = controller => ({
  serviceWorker: { controller },
});

describe('onUpdateAvailable', () => {
  it('calls callback when new worker reaches installed state and controller exists', () => {
    const newWorker = { state: 'installing' };
    const workerListeners = {};
    newWorker.addEventListener = (event, fn) => {
      workerListeners[event] = fn;
    };

    const registration = { installing: newWorker };
    const regListeners = {};
    registration.addEventListener = (event, fn) => {
      regListeners[event] = fn;
    };

    let called = false;
    onUpdateAvailable(
      registration,
      () => {
        called = true;
      },
      mockNavigator({}),
    );

    regListeners.updatefound();
    newWorker.state = 'installed';
    workerListeners.statechange();

    assert.equal(called, true);
  });

  it('does not call callback when new worker is installed but no controller exists', () => {
    const newWorker = { state: 'installing' };
    const workerListeners = {};
    newWorker.addEventListener = (event, fn) => {
      workerListeners[event] = fn;
    };

    const registration = { installing: newWorker };
    const regListeners = {};
    registration.addEventListener = (event, fn) => {
      regListeners[event] = fn;
    };

    let called = false;
    onUpdateAvailable(
      registration,
      () => {
        called = true;
      },
      mockNavigator(null),
    );

    regListeners.updatefound();
    newWorker.state = 'installed';
    workerListeners.statechange();

    assert.equal(called, false);
  });

  it('does not call callback on intermediate states', () => {
    const newWorker = { state: 'installing' };
    const workerListeners = {};
    newWorker.addEventListener = (event, fn) => {
      workerListeners[event] = fn;
    };

    const registration = { installing: newWorker };
    const regListeners = {};
    registration.addEventListener = (event, fn) => {
      regListeners[event] = fn;
    };

    let called = false;
    onUpdateAvailable(
      registration,
      () => {
        called = true;
      },
      mockNavigator({}),
    );

    regListeners.updatefound();
    newWorker.state = 'installing';
    workerListeners.statechange();

    assert.equal(called, false);
  });

  it('does nothing when registration is null', () => {
    let called = false;
    onUpdateAvailable(null, () => {
      called = true;
    });
    assert.equal(called, false);
  });
});

describe('applyUpdate', () => {
  it('sends skipWaiting when registration has a waiting worker', () => {
    let posted;
    const registration = {
      waiting: {
        postMessage: msg => {
          posted = msg;
        },
      },
    };
    applyUpdate(registration);
    assert.equal(posted, 'skipWaiting');
  });

  it('does nothing when registration is null', () => {
    applyUpdate(null);
  });

  it('does nothing when registration has no waiting worker', () => {
    const registration = {};
    applyUpdate(registration);
  });
});
