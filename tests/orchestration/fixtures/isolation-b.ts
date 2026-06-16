import {testSuite} from '../../test-suite.ts'
import {claimIsolation} from './isolation-state.ts'

testSuite('isolation suite B', suite => {
  if (!claimIsolation()) {
    console.error('isolation suite B observed prior module state')
    suite.fail()
  }
  console.log('isolation suite B completed')
})
