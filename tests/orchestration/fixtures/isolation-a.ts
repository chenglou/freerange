import {test} from 'bun:test'
import {claimIsolation} from './isolation-state.ts'

test('isolation suite A', () => {
  if (!claimIsolation()) throw new Error('isolation suite A observed prior module state')
  console.log('isolation suite A completed')
})
