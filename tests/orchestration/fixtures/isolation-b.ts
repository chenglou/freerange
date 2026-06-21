import {test} from 'bun:test'
import {claimIsolation} from './isolation-state.ts'

test('isolation suite B', () => {
  if (!claimIsolation()) throw new Error('isolation suite B observed prior module state')
  console.log('isolation suite B completed')
})
