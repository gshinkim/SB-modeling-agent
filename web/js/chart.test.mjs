import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dashOf } from './chart.mjs';

test('a large model never gives two series the same colour and dash', () => {
  const styles = Array.from({ length: 128 }, (_, i) => `${i % 8}:${dashOf(i)}`);
  assert.equal(new Set(styles).size, styles.length);
  assert.equal(dashOf(0), null);
  assert.equal(dashOf(8), '7 4');
  assert.equal(dashOf(16), '2 3');
});
