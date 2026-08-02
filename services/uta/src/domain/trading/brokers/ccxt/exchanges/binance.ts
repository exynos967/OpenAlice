/**
 * Binance-specific overrides for CcxtBroker.
 *
 * Binance separates trading wallets from investment products. CCXT's unified
 * fetchBalance() covers Spot / USDⓈ-M / COIN-M, while Simple Earn and RWUSD
 * require signed SAPI endpoints and must be folded into aggregate equity.
 */

import Decimal from 'decimal.js'
import type { Exchange } from 'ccxt'
import type { CcxtExchangeOverrides } from '../overrides.js'

type BinanceExchange = Exchange & {
  sapiGetSimpleEarnAccount?: (params?: Record<string, unknown>) => Promise<unknown>
  sapiGetRwusdAccount?: (params?: Record<string, unknown>) => Promise<unknown>
}

function optionalAmount(response: unknown, field: string, product: string): Decimal {
  if (typeof response !== 'object' || response === null) return new Decimal(0)
  const value = (response as Record<string, unknown>)[field]
  if (value === undefined || value === null || value === '') return new Decimal(0)

  try {
    const amount = new Decimal(String(value))
    if (amount.isFinite() && amount.gte(0)) return amount
  } catch { /* warned below */ }

  console.warn(`CcxtBroker[binance]: invalid ${product} balance, skipped`)
  return new Decimal(0)
}

function warnUnavailable(product: string, err: unknown): void {
  const detail = err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120)
  console.warn(`CcxtBroker[binance]: ${product} account skipped — ${detail}`)
}

async function fetchSimpleEarnEquity(exchange: BinanceExchange): Promise<Decimal> {
  try {
    const response = exchange.sapiGetSimpleEarnAccount
      ? await exchange.sapiGetSimpleEarnAccount({})
      : await exchange.request('simple-earn/account', 'sapi', 'GET', {})
    return optionalAmount(response, 'totalAmountInUSDT', 'Simple Earn')
  } catch (err) {
    warnUnavailable('Simple Earn', err)
    return new Decimal(0)
  }
}

async function fetchRwusdEquity(exchange: BinanceExchange): Promise<Decimal> {
  try {
    const response = exchange.sapiGetRwusdAccount
      ? await exchange.sapiGetRwusdAccount({})
      : await exchange.request('rwusd/account', 'sapi', 'GET', {})
    return optionalAmount(response, 'rwusdAmount', 'RWUSD')
  } catch (err) {
    warnUnavailable('RWUSD', err)
    return new Decimal(0)
  }
}

/** Binance keeps trading wallets as scoped sub-accounts, but Simple Earn and
 * RWUSD are read-only investment products and only contribute to aggregate
 * account equity. Product failures are isolated so Spot remains usable. */
export const binanceOverrides: CcxtExchangeOverrides = {
  subAccounts: [
    { id: 'spot', label: 'Spot', kind: 'spot', walletTypes: ['spot'] },
    { id: 'derivatives', label: 'Futures', kind: 'derivatives', walletTypes: ['future', 'delivery'] },
  ],

  async fetchSupplementalAccountEquity(exchange: Exchange): Promise<string> {
    const binance = exchange as BinanceExchange
    let total = new Decimal(0)
    total = total.plus(await fetchSimpleEarnEquity(binance))
    total = total.plus(await fetchRwusdEquity(binance))
    return total.toString()
  },
}
