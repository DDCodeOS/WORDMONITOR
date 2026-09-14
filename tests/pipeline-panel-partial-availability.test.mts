import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { shouldErrorOnPipelineLiveResponse } from '../src/shared/pipeline-live-paint.ts';

describe('PipelineStatusPanel live paint gate — partial availability', () => {
  test('keeps partial rows when one registry is missing', () => {
    assert.equal(
      shouldErrorOnPipelineLiveResponse({
        pipelines: [{ id: 'gas1' } as never],
      }),
      false,
    );
  });

  test('errors when the live response has no pipelines', () => {
    assert.equal(shouldErrorOnPipelineLiveResponse({ pipelines: [] }), true);
  });

  test('errors when pipelines is missing', () => {
    assert.equal(shouldErrorOnPipelineLiveResponse({ pipelines: undefined as never }), true);
  });
});
