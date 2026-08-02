import { describe, expect, it } from 'vitest'

import { BrokerError } from './broker.js'

describe('BrokerError.from', () => {
  it('preserves a structured error from a separately loaded broker pack', () => {
    const packError = Object.assign(new Error('credentials were rejected'), {
      name: 'BrokerError',
      code: 'AUTH',
      permanent: true,
    })

    const wrapped = BrokerError.from(packError)

    expect(wrapped).toBeInstanceOf(BrokerError)
    expect(wrapped.code).toBe('AUTH')
    expect(wrapped.permanent).toBe(true)
    expect(wrapped.cause).toBe(packError)
  })

  it('does not trust an unknown structured code', () => {
    const invalid = Object.assign(new Error('opaque failure'), {
      name: 'BrokerError',
      code: 'NOT_A_REAL_CODE',
    })

    expect(BrokerError.from(invalid).code).toBe('UNKNOWN')
  })

  it('classifies Binance -2015 as an authentication or permission error', () => {
    const err = new Error('binance {"code":-2015,"msg":"Invalid API-key, IP, or permissions for action"}')

    expect(BrokerError.from(err).code).toBe('AUTH')
  })

  it('classifies a timed-out request as a network error', () => {
    expect(BrokerError.from(new Error('request timed out (10000 ms)')).code).toBe('NETWORK')
  })
})
