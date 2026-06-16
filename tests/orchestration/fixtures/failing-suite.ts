import {testSuite} from '../../test-suite.ts'

testSuite('controlled failing suite', suite => {
  console.error('controlled failure detail')
  suite.fail()
})
