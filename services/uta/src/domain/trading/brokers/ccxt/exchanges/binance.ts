/**
 * Binance-specific overrides for CcxtBroker.
 *
 * Binance separates trading wallets from investment products. CCXT's unified
 * fetchBalance() covers Spot / USDⓈ-M / COIN-M, while Simple Earn, RWUSD, and
 * Dual Investment require signed SAPI endpoints and must be folded into
 * aggregate equity.
 */

import Decimal from 'decimal.js'
import type { Exchange } from 'ccxt'
import type { InvestmentHolding } from '../../types.js'
import type { CcxtExchangeOverrides } from '../overrides.js'

type BinanceExchange = Exchange & {
  sapiGetSimpleEarnAccount?: (params?: Record<string, unknown>) => Promise<unknown>
  sapiGetSimpleEarnFlexiblePosition?: (params?: Record<string, unknown>) => Promise<unknown>
  sapiGetSimpleEarnLockedPosition?: (params?: Record<string, unknown>) => Promise<unknown>
  sapiGetRwusdAccount?: (params?: Record<string, unknown>) => Promise<unknown>
  sapiGetRwusdHistoryRateHistory?: (params?: Record<string, unknown>) => Promise<unknown>
  sapiGetDciProductAccounts?: (params?: Record<string, unknown>) => Promise<unknown>
  sapiGetDciProductPositions?: (params?: Record<string, unknown>) => Promise<unknown>
  sapiV3PostAssetGetUserAsset?: (params?: Record<string, unknown>) => Promise<unknown>
}

const PAGE_SIZE = 100
// Each position page costs 150 request weight; keep one account read bounded.
const MAX_PAGES = 5

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

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
}

function rows(response: unknown): Record<string, unknown>[] {
  const value = record(response)?.['rows']
  return Array.isArray(value) ? value.map(record).filter((row): row is Record<string, unknown> => row !== null) : []
}

function list(response: unknown): Record<string, unknown>[] {
  const value = record(response)?.['list']
  return Array.isArray(value) ? value.map(record).filter((row): row is Record<string, unknown> => row !== null) : []
}

function optionalRate(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  try {
    const rate = new Decimal(String(value))
    if (rate.isFinite() && rate.gte(0)) return rate.toString()
  } catch { /* invalid rates are omitted */ }
  return undefined
}

function holding(
  product: string,
  row: Record<string, unknown>,
  amountField: string,
  rateFields: string[],
): InvestmentHolding | null {
  const asset = typeof row['asset'] === 'string' ? row['asset'].trim().toUpperCase() : ''
  if (!asset) return null

  const amount = optionalAmount(row, amountField, `${product} holding`)
  if (amount.lte(0)) return null

  const annualPercentageRate = optionalRate(
    rateFields.map(field => row[field]).find(value => value !== undefined && value !== null && value !== ''),
  )
  return {
    product,
    asset,
    amount: amount.toString(),
    ...(annualPercentageRate === undefined ? {} : { annualPercentageRate }),
  }
}

async function fetchPagedRows(
  exchange: BinanceExchange,
  implicit: ((params?: Record<string, unknown>) => Promise<unknown>) | undefined,
  path: string,
  product: string,
): Promise<Record<string, unknown>[]> {
  const result: Record<string, unknown>[] = []
  try {
    for (let current = 1; current <= MAX_PAGES; current += 1) {
      const params = { current, size: PAGE_SIZE }
      const response = implicit
        ? await implicit.call(exchange, params)
        : await exchange.request(path, 'sapi', 'GET', params)
      const page = rows(response)
      result.push(...page)

      const rawTotal = record(response)?.['total']
      const total = rawTotal === undefined ? Number.NaN : Number(rawTotal)
      if (page.length < PAGE_SIZE || (Number.isFinite(total) && result.length >= total)) return result
    }
    console.warn(`CcxtBroker[binance]: ${product} positions truncated after ${MAX_PAGES * PAGE_SIZE} rows`)
    return result
  } catch (err) {
    warnUnavailable(`${product} positions`, err)
    return result
  }
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

async function fetchSimpleEarnHoldings(exchange: BinanceExchange): Promise<InvestmentHolding[]> {
  const [flexibleRows, lockedRows] = await Promise.all([
    fetchPagedRows(
      exchange,
      exchange.sapiGetSimpleEarnFlexiblePosition,
      'simple-earn/flexible/position',
      'Simple Earn flexible',
    ),
    fetchPagedRows(
      exchange,
      exchange.sapiGetSimpleEarnLockedPosition,
      'simple-earn/locked/position',
      'Simple Earn locked',
    ),
  ])

  return [
    ...flexibleRows.map(row => holding(
      'simple-earn-flexible',
      row,
      'totalAmount',
      ['latestAnnualPercentageRate'],
    )),
    ...lockedRows.map(row => holding('simple-earn-locked', row, 'amount', ['APY', 'apy'])),
  ].filter((value): value is InvestmentHolding => value !== null)
}

async function fetchRwusdRate(exchange: BinanceExchange): Promise<string | undefined> {
  try {
    const params = { current: 1, size: 1 }
    const response = exchange.sapiGetRwusdHistoryRateHistory
      ? await exchange.sapiGetRwusdHistoryRateHistory(params)
      : await exchange.request('rwusd/history/rateHistory', 'sapi', 'GET', params)
    return optionalRate(rows(response)[0]?.['annualPercentageRate'])
  } catch (err) {
    warnUnavailable('RWUSD rate', err)
    return undefined
  }
}

async function fetchRwusd(exchange: BinanceExchange): Promise<{
  equity: Decimal
  investment: InvestmentHolding | null
}> {
  try {
    const response = exchange.sapiGetRwusdAccount
      ? await exchange.sapiGetRwusdAccount({})
      : await exchange.request('rwusd/account', 'sapi', 'GET', {})
    const amount = optionalAmount(response, 'rwusdAmount', 'RWUSD')
    if (amount.lte(0)) return { equity: amount, investment: null }
    const annualPercentageRate = await fetchRwusdRate(exchange)
    return {
      equity: amount,
      investment: {
        product: 'rwusd',
        asset: 'RWUSD',
        amount: amount.toString(),
        ...(annualPercentageRate === undefined ? {} : { annualPercentageRate }),
      },
    }
  } catch (err) {
    warnUnavailable('RWUSD', err)
    return { equity: new Decimal(0), investment: null }
  }
}

const ACTIVE_DUAL_INVESTMENT_STATUSES = new Set([
  'PENDING',
  'PURCHASE_SUCCESS',
  'SETTLING',
  'REFUNDING',
])

async function fetchDualInvestmentHoldings(exchange: BinanceExchange): Promise<InvestmentHolding[]> {
  const result: InvestmentHolding[] = []
  try {
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const params = { page, size: PAGE_SIZE }
      const response = exchange.sapiGetDciProductPositions
        ? await exchange.sapiGetDciProductPositions(params)
        : await exchange.request('dci/product/positions', 'sapi', 'GET', params)
      const positions = list(response)

      for (const position of positions) {
        const status = typeof position['purchaseStatus'] === 'string'
          ? position['purchaseStatus'].trim().toUpperCase()
          : ''
        if (!ACTIVE_DUAL_INVESTMENT_STATUSES.has(status)) continue

        const asset = typeof position['investCoin'] === 'string'
          ? position['investCoin'].trim().toUpperCase()
          : ''
        if (!asset) continue
        const amount = optionalAmount(position, 'subscriptionAmount', 'Dual Investment holding')
        if (amount.lte(0)) continue
        const annualPercentageRate = optionalRate(position['apr'])
        result.push({
          product: 'dual-investment',
          asset,
          amount: amount.toString(),
          ...(annualPercentageRate === undefined ? {} : { annualPercentageRate }),
        })
      }

      const rawTotal = record(response)?.['total']
      const total = rawTotal === undefined ? Number.NaN : Number(rawTotal)
      if (positions.length < PAGE_SIZE || (Number.isFinite(total) && page * PAGE_SIZE >= total)) return result
    }
    console.warn(`CcxtBroker[binance]: Dual Investment positions truncated after ${MAX_PAGES * PAGE_SIZE} rows`)
    return result
  } catch (err) {
    warnUnavailable('Dual Investment positions', err)
    return result
  }
}

async function fetchDualInvestment(exchange: BinanceExchange): Promise<{
  equity: Decimal
  investments: InvestmentHolding[]
}> {
  const [equity, investments] = await Promise.all([
    (async (): Promise<Decimal> => {
      try {
        const response = exchange.sapiGetDciProductAccounts
          ? await exchange.sapiGetDciProductAccounts({})
          : await exchange.request('dci/product/accounts', 'sapi', 'GET', {})
        return optionalAmount(response, 'totalAmountInUSDT', 'Dual Investment')
      } catch (err) {
        warnUnavailable('Dual Investment', err)
        return new Decimal(0)
      }
    })(),
    fetchDualInvestmentHoldings(exchange),
  ])
  return { equity, investments }
}

function balanceTotal(balance: Record<string, unknown> | null): Decimal {
  if (balance === null) return new Decimal(0)
  const total = optionalAmount(balance, 'total', 'spot wallet')
  if (total.gt(0)) return total
  return optionalAmount(balance, 'free', 'spot wallet').plus(optionalAmount(balance, 'used', 'spot wallet'))
}

async function augmentBinanceSpotBalance(
  exchange: BinanceExchange,
  walletType: string | undefined,
  balance: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (walletType !== 'spot') return balance

  try {
    const response = exchange.sapiV3PostAssetGetUserAsset
      ? await exchange.sapiV3PostAssetGetUserAsset({})
      : await exchange.request('asset/getUserAsset', 'sapiV3', 'POST', {})
    if (!Array.isArray(response)) return balance

    const marketAssets = new Set(
      Object.values(exchange.markets ?? {})
        .filter(market => market.active !== false
          && market.type === 'spot'
          && ['USDT', 'USDC', 'USD'].includes(String(market.quote ?? '').toUpperCase()))
        .map(market => String(market.base ?? '').toUpperCase())
        .filter(Boolean),
    )
    const augmented = { ...balance }
    for (const value of response) {
      const assetRow = record(value)
      const asset = typeof assetRow?.['asset'] === 'string' ? assetRow['asset'].trim().toUpperCase() : ''
      if (!asset || !marketAssets.has(asset) || balanceTotal(record(augmented[asset])).gt(0)) continue

      const free = optionalAmount(assetRow, 'free', `${asset} User Asset`)
      const used = optionalAmount(assetRow, 'locked', `${asset} User Asset`)
        .plus(optionalAmount(assetRow, 'freeze', `${asset} User Asset`))
        .plus(optionalAmount(assetRow, 'withdrawing', `${asset} User Asset`))
      const total = free.plus(used)
      if (total.lte(0)) continue
      augmented[asset] = { free: free.toString(), used: used.toString(), total: total.toString() }
    }
    return augmented
  } catch (err) {
    warnUnavailable('User Asset supplement', err)
    return balance
  }
}

/** Binance keeps trading wallets as scoped sub-accounts, but Simple Earn,
 * RWUSD, and Dual Investment are read-only investment products and only
 * contribute to aggregate account equity. Product failures are isolated so
 * Spot remains usable. */
export const binanceOverrides: CcxtExchangeOverrides = {
  subAccounts: [
    { id: 'spot', label: 'Spot', kind: 'spot', walletTypes: ['spot'] },
    { id: 'derivatives', label: 'Futures', kind: 'derivatives', walletTypes: ['future', 'delivery'] },
  ],

  augmentWalletBalance(exchange, walletType, balance): Promise<Record<string, unknown>> {
    return augmentBinanceSpotBalance(exchange as BinanceExchange, walletType, balance)
  },

  async fetchSupplementalAccount(exchange: Exchange): Promise<{
    equity: string
    investments: InvestmentHolding[]
  }> {
    const binance = exchange as BinanceExchange
    const [simpleEarnEquity, simpleEarnHoldings, rwusd, dualInvestment] = await Promise.all([
      fetchSimpleEarnEquity(binance),
      fetchSimpleEarnHoldings(binance),
      fetchRwusd(binance),
      fetchDualInvestment(binance),
    ])
    return {
      equity: simpleEarnEquity.plus(rwusd.equity).plus(dualInvestment.equity).toString(),
      investments: [
        ...simpleEarnHoldings,
        ...(rwusd.investment === null ? [] : [rwusd.investment]),
        ...dualInvestment.investments,
      ],
    }
  },
}
