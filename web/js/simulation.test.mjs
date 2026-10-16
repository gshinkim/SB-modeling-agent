import assert from 'node:assert/strict';
import test from 'node:test';
import { simulationSettings, simulationError } from './simulation.mjs';

test('simulation settings preserve zero and reject incomplete or invalid windows', () => {
  assert.deepEqual(simulationSettings({ start: '-1', end: '0', points: '50' }), { start: -1, end: 0, points: 50 });
  assert.equal(simulationError(simulationSettings({ start: '0', end: '0', points: '50' })), 'End time must exceed start');
  assert.equal(simulationError(simulationSettings({ start: '0', end: '', points: '50' })), 'Enter a finite start and end time');
  assert.equal(simulationError({ start: 0, end: Infinity, points: 50 }), 'Enter a finite start and end time');
  for(const points of ['', '0', '1', '2.5', '20001'])
    assert.match(simulationError(simulationSettings({ start: '0', end: '100', points })), /^Points must/);
  assert.equal(simulationError({ start: -1, end: 0, points: 2 }), '');
  assert.equal(simulationError({ start: NaN, end: NaN, points: 50 }, true), '', 'disabled time fields do not block steady-state mode');
});
