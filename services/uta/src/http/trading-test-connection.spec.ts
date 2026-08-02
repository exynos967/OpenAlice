import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UTAEngineContext } from '../types.js'
import { createTradingRoutes } from './routes-trading.js'

const factoryMocks = vi.hoisted(() => ({
  createBroker: vi.fn(),
}))

vi.mock('../domain/trading/brokers/factory.js', () => ({
  createBroker: factoryMocks.createBroker,
}))

function makeRoutes() {
  const ctx = {
    utaManager: {
      resolve: () => [],
      listUTAs: () => [],
      getAggregatedEquity: vi.fn(),
    },
    snapshotService: undefined,
  } as unknown as UTAEngineContext
  return createTradingRoutes(ctx)
}

async function testConnection() {
  const routes = makeRoutes()
  const response = await routes.request('/test-connection', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      presetId: 'binance',
      presetConfig: { mode: 'live', apiKey: 'test-key', secret: 'test-secret' },
    }),
  })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

describe('POST /test-connection', () => {
  beforeEach(() => {
    factoryMocks.createBroker.mockReset()
  })

  it('accepts a readable account when optional position access is unavailable', async () => {
    const account = { baseCurrency: 'USD', netLiquidation: '10', totalCashValue: '10' }
    const broker = {
      init: vi.fn().mockResolvedValue(undefined),
      getAccount: vi.fn().mockResolvedValue(account),
      getPositions: vi.fn().mockRejectedValue(new Error('binance {"code":-2015,"msg":"Invalid API-key, IP, or permissions for action"}')),
      close: vi.fn().mockResolvedValue(undefined),
    }
    factoryMocks.createBroker.mockResolvedValue(broker)

    const result = await testConnection()

    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({
      success: true,
      account,
      positions: [],
      warning: 'Account connected, but position access was rejected with the current credentials.',
    })
    expect(broker.close).toHaveBeenCalledOnce()
  })

  it('still rejects the connection when the account itself is unreadable', async () => {
    const broker = {
      init: vi.fn().mockResolvedValue(undefined),
      getAccount: vi.fn().mockRejectedValue(new Error('Invalid credentials')),
      getPositions: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    }
    factoryMocks.createBroker.mockResolvedValue(broker)

    const result = await testConnection()

    expect(result.status).toBe(400)
    expect(result.body).toEqual({ success: false, error: 'Invalid credentials' })
    expect(broker.getPositions).not.toHaveBeenCalled()
    expect(broker.close).toHaveBeenCalledOnce()
  })

  it('rejects transient position failures instead of misreporting partial access', async () => {
    const broker = {
      init: vi.fn().mockResolvedValue(undefined),
      getAccount: vi.fn().mockResolvedValue({ baseCurrency: 'USD' }),
      getPositions: vi.fn().mockRejectedValue(new Error('request timed out')),
      close: vi.fn().mockResolvedValue(undefined),
    }
    factoryMocks.createBroker.mockResolvedValue(broker)

    const result = await testConnection()

    expect(result.status).toBe(400)
    expect(result.body).toEqual({ success: false, error: 'request timed out' })
    expect(broker.close).toHaveBeenCalledOnce()
  })
})
