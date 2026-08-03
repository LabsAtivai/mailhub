import { describe, it, expect, vi } from 'vitest'
import { AccountSerialQueue } from '../serialQueue'

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('AccountSerialQueue', () => {
  it('serializa tarefas da mesma conta na ordem de chegada', async () => {
    const queue = new AccountSerialQueue()
    const order: number[] = []
    const task = (n: number, delay: number) => async () => {
      await sleep(delay)
      order.push(n)
    }
    await Promise.all([
      queue.run('acc1', task(1, 30)),
      queue.run('acc1', task(2, 10)),
      queue.run('acc1', task(3, 5)),
    ])
    expect(order).toEqual([1, 2, 3])
  })

  it('roda contas diferentes em paralelo, nao em serie', async () => {
    const queue = new AccountSerialQueue()
    const running = new Set<string>()
    let maxConcurrent = 0
    const task = (id: string) => async () => {
      running.add(id)
      maxConcurrent = Math.max(maxConcurrent, running.size)
      await sleep(20)
      running.delete(id)
    }
    await Promise.all([
      queue.run('acc1', task('a')),
      queue.run('acc2', task('b')),
      queue.run('acc3', task('c')),
    ])
    expect(maxConcurrent).toBeGreaterThan(1)
  })

  it('uma tarefa que falha nao trava as proximas da mesma conta', async () => {
    const queue = new AccountSerialQueue()
    const results: string[] = []
    const first = queue.run('acc1', async () => { throw new Error('boom') })
    const second = queue.run('acc1', async () => { results.push('second ran') })
    await expect(first).rejects.toThrow('boom')
    await second
    expect(results).toEqual(['second ran'])
  })

  it('propaga o retorno/erro de cada tarefa pra sua propria chamada', async () => {
    const queue = new AccountSerialQueue()
    const spy = vi.fn()
    await queue.run('acc1', async () => { spy('a') })
    await queue.run('acc1', async () => { spy('b') })
    expect(spy.mock.calls).toEqual([['a'], ['b']])
  })
})
