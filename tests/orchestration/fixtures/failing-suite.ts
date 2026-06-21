import {test} from 'bun:test'

test('controlled failing suite', () => {
  throw new Error('controlled failure detail')
})
