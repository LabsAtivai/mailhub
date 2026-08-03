// Comandos Redis pra mesma conta chegavam sem ordem nenhuma entre si (ioredis
// dispara cada 'message' sem esperar o handler anterior terminar) — um
// sync:start e um sent:append pra mesma conta, por exemplo, podiam rodar dois
// syncAccount() concorrentes; como só um vence a guarda de syncState, o outro
// virava no-op silencioso. Isso serializa por conta (contas diferentes
// continuam em paralelo) sem depender de nenhuma correção pontual isolada.
export class AccountSerialQueue {
  private queues = new Map<string, Promise<void>>()

  run(accountId: string, task: () => Promise<void>): Promise<void> {
    const prev = this.queues.get(accountId) ?? Promise.resolve()
    const run = prev.then(task, task)
    this.queues.set(accountId, run.then(() => undefined, () => undefined))
    return run
  }
}
