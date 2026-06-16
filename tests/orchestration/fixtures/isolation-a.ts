import {testSuite} from '../../test-suite.ts'
import {claimIsolation} from './isolation-state.ts'

testSuite('isolation suite A', suite => {
  if (!claimIsolation()) {
    console.error('isolation suite A observed prior module state')
    suite.fail()
  }
  console.log('isolation suite A completed')
})
