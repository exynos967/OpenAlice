/**
 * Binance overrides unit tests.
 *
 * Focus: supplemental account aggregation (Simple Earn / RWUSD / Dual
 * Investment) and the DCI pagination wire contract — dci/product/positions
 * paginates with pageIndex/pageSize and returns a `list` field, unlike the
 * current/size + rows convention used by Simple Earn.
 */
import { describe, it, expect, vi } from 'vitest'
import type { Exchange } from 'ccxt'
import { binanceOverrides } from './binance.js'

function makeExchange(methods: Record<string, (params?: Record<string, unknown>) => Promise<unknown>>): Exchange {
  return methods as unknown as Exchange
}

describe('binanceOverrides.fetchSupplementalAccount', () => {
  it('aggregates Simple Earn, RWUSD, and Dual Investment equity and holdings', async () => {
    const exchange = makeExchange({
      sapiGetSimpleEarnAccount: async () => ({ totalAmountInUSDT: '110.5' }),
      sapiGetSimpleEarnFlexiblePosition: async () => ({
        rows: [{ asset: 'usdt', totalAmount: '100', latestAnnualPercentageRate: '0.05' }],
        total: 1,
      }),
      sapiGetSimpleEarnLockedPosition: async () => ({
        rows: [{ asset: 'bnb', amount: '2', APY: '0.031' }],
        total: 1,
      }),
      sapiGetRwusdAccount: async () => ({ rwusdAmount: '50' }),
      sapiGetRwusdHistoryRateHistory: async () => ({ rows: [{ annualPercentageRate: '0.041' }] }),
      sapiGetDciProductAccounts: async () => ({ totalAmountInUSDT: '25' }),
      sapiGetDciProductPositions: async () => ({
        list: [
          { investCoin: 'BTC', subscriptionAmount: '0.5', purchaseStatus: 'PURCHASE_SUCCESS', apr: '0.25' },
          { investCoin: 'ETH', subscriptionAmount: '10', purchaseStatus: 'SETTLED', apr: '0.3' },
        ],
        total: 2,
      }),
    })

    const result = await binanceOverrides.fetchSupplementalAccount!(exchange)

    expect(result.equity).toBe('185.5')
    expect(result.investments).toEqual([
      { product: 'simple-earn-flexible', asset: 'USDT', amount: '100', annualPercentageRate: '0.05' },
      { product: 'simple-earn-locked', asset: 'BNB', amount: '2', annualPercentageRate: '0.031' },
      { product: 'rwusd', asset: 'RWUSD', amount: '50', annualPercentageRate: '0.041' },
      { product: 'dual-investment', asset: 'BTC', amount: '0.5', annualPercentageRate: '0.25' },
    ])
  })

  it('paginates Dual Investment positions with pageIndex/pageSize', async () => {
    const positions = vi.fn(async (params?: Record<string, unknown>) => ({
      list: [{ investCoin: 'BTC', subscriptionAmount: '1', purchaseStatus: 'PENDING' }],
      total: 1,
    }))
    const exchange = makeExchange({
      sapiGetSimpleEarnAccount: async () => ({ totalAmountInUSDT: '0' }),
      sapiGetSimpleEarnFlexiblePosition: async () => ({ rows: [], total: 0 }),
      sapiGetSimpleEarnLockedPosition: async () => ({ rows: [], total: 0 }),
      sapiGetRwusdAccount: async () => ({ rwusdAmount: '0' }),
      sapiGetDciProductAccounts: async () => ({ totalAmountInUSDT: '0' }),
      sapiGetDciProductPositions: positions,
    })

    const result = await binanceOverrides.fetchSupplementalAccount!(exchange)

    expect(positions).toHaveBeenCalledWith({ pageIndex: 1, pageSize: 100 })
    expect(result.investments).toEqual([
      { product: 'dual-investment', asset: 'BTC', amount: '1' },
    ])
  })

  it('degrades to zero equity when every product endpoint rejects', async () => {
    const reject = async () => { throw new Error('binance {"code":-2015,"msg":"Invalid API-key"}') }
    const exchange = makeExchange({
      sapiGetSimpleEarnAccount: reject,
      sapiGetSimpleEarnFlexiblePosition: reject,
      sapiGetSimpleEarnLockedPosition: reject,
      sapiGetRwusdAccount: reject,
      sapiGetRwusdHistoryRateHistory: reject,
      sapiGetDciProductAccounts: reject,
      sapiGetDciProductPositions: reject,
    })

    const result = await binanceOverrides.fetchSupplementalAccount!(exchange)

    expect(result).toEqual({ equity: '0', investments: [] })
  })
})
