import { eth, txUtils } from 'decentraland-eth'
import {
  call,
  put,
  select,
  takeEvery,
  ForkEffect,
  fork
} from 'redux-saga/effects'
import { delay } from 'redux-saga'
import { Transaction, FINISHED_TYPES } from './types'
import {
  fetchTransactionFailure,
  fetchTransactionSuccess,
  FETCH_TRANSACTION_REQUEST,
  WATCH_PENDING_TRANSACTIONS,
  FetchTransactionRequestAction,
  watchPendingTransactions,
  updateTransactionStatus,
  updateTransactionNonce,
  ReplaceTransactionRequestAction,
  replaceTransactionRequest,
  watchDroppedTransactions,
  WATCH_DROPPED_TRANSACTIONS,
  replaceTransactionSuccess,
  REPLACE_TRANSACTION_REQUEST,
  fetchTransactionRequest
} from './actions'
import {
  CONNECT_WALLET_SUCCESS,
  ConnectWalletSuccessAction
} from '../wallet/actions'
import { getData, getLoading, getTransaction } from './selectors'
import { isPending } from './utils'
import { TransactionStatus } from 'decentraland-eth/dist/ethereum/wallets/Wallet'

export function* transactionSaga(): IterableIterator<ForkEffect> {
  yield takeEvery(FETCH_TRANSACTION_REQUEST, handleFetchTransactionRequest)
  yield takeEvery(REPLACE_TRANSACTION_REQUEST, handleReplaceTransactionRequest)
  yield takeEvery(WATCH_PENDING_TRANSACTIONS, handleWatchPendingTransactions)
  yield takeEvery(WATCH_DROPPED_TRANSACTIONS, handleWatchDroppedTransactions)
  yield takeEvery(CONNECT_WALLET_SUCCESS, handleConnectWalletSuccess)
}

const watchPendingIndex: { [hash: string]: boolean } = {
  // hash: true
}

const watchDroppedIndex: { [hash: string]: boolean } = {
  // hash: true
}

export class FailedTransactionError extends Error {
  public hash: string
  public status: txUtils.Transaction['type']
  constructor(hash: string, status: txUtils.Transaction['type']) {
    super(`[${hash}] ${status}`) // 'Error' breaks prototype chain here
    this.hash = hash
    this.status = status
    Object.setPrototypeOf(this, new.target.prototype) // restore prototype chain
  }
}

function* handleFetchTransactionRequest(action: FetchTransactionRequestAction) {
  const hash = action.payload.hash
  const transactions: Transaction[] = yield select(getData)
  const transaction = transactions.find(tx => tx.hash === hash)
  if (!transaction) return undefined

  try {
    watchPendingIndex[hash] = true

    let tx: txUtils.Transaction = yield call(() => txUtils.getTransaction(hash))
    let isUnknown = tx == null

    // loop while tx is pending
    while (isUnknown || isPending(tx.type)) {
      const txInState: Transaction = yield select(state =>
        getTransaction(state, hash)
      )

      // update nonce
      const nonceInState = txInState == null ? null : txInState.nonce
      const nonceInNetwork = isUnknown ? null : (tx as TransactionStatus).nonce

      if (nonceInNetwork != null && nonceInState == null) {
        yield put(updateTransactionNonce(hash, nonceInNetwork))
      }

      // update status
      const statusInState = txInState == null ? null : txInState.status
      const statusInNetwork = isUnknown ? null : tx.type

      if (statusInState !== statusInNetwork) {
        // check if dropped
        if (statusInState != null && statusInNetwork == null) {
          const nonce = nonceInState || nonceInNetwork
          if (nonce) {
            yield put(replaceTransactionRequest(hash, nonce))
          }
          throw new FailedTransactionError(
            hash,
            txUtils.TRANSACTION_TYPES.dropped
          )
        }
        yield put(updateTransactionStatus(hash, statusInNetwork))
      }

      // sleep
      yield call(delay, txUtils.TRANSACTION_FETCH_DELAY)

      // update tx status from network
      tx = yield call(() => txUtils.getTransaction(hash))
      isUnknown = tx == null
    }

    delete watchPendingIndex[hash]

    if (tx.type === 'confirmed') {
      yield put(
        fetchTransactionSuccess({
          ...transaction,
          status: tx.type,
          receipt: {
            logs: transaction.withReceipt ? tx.receipt.logs : []
          }
        })
      )
    } else {
      throw new FailedTransactionError(tx.hash, tx.type)
    }
  } catch (error) {
    yield put(fetchTransactionFailure(error.hash, error.status, error.message))
  }
}

function* handleReplaceTransactionRequest(
  action: ReplaceTransactionRequestAction
) {
  const account = eth.getAccount()
  const { hash, nonce } = action.payload

  watchDroppedIndex[hash] = true

  let checkpoint = null

  while (true) {
    // check if tx has status, this is to recover from a tx that is dropped momentarily
    const tx = yield call(() => txUtils.getTransaction(hash))
    if (tx != null) {
      yield put(fetchTransactionRequest(account, hash, { type: null }))
      break
    }

    // get latest block
    const blockNumber = yield call(() => eth.getBlockNumber())

    let highestNonce = 0
    let replacedBy = null

    // loop through the last 100
    const startBlock = blockNumber
    const endBlock = checkpoint || blockNumber - 100
    for (let i = startBlock; i > endBlock; i--) {
      let block = yield call(() => eth.getBlock(i, true))
      const transactions: TransactionStatus[] =
        block != null && block.transactions != null ? block.transactions : []

      // look for a replacement tx, if so break the loop
      replacedBy = transactions.find(
        tx => tx.nonce === nonce && tx.from === account
      )
      if (replacedBy) break

      // if no replacement is found, keep track of the highest nonce for the account
      highestNonce = transactions
        .filter(tx => tx.from === account)
        .reduce((max, tx) => Math.max(max, tx.nonce), highestNonce)
    }

    checkpoint = blockNumber

    // if a replacement tx was found, replace it
    if (replacedBy) {
      yield put(replaceTransactionSuccess(hash, replacedBy.hash))
      break
    }

    // if there was nonce higher to than the one in the tx, we can mark it as replaced (altough we don't know which tx replaced it)
    if (highestNonce >= nonce) {
      yield put(
        updateTransactionStatus(
          action.payload.hash,
          txUtils.TRANSACTION_TYPES.replaced
        )
      )
      break
    }

    // sleep
    yield call(delay, txUtils.TRANSACTION_FETCH_DELAY)
  }

  delete watchDroppedIndex[action.payload.hash]
}

function* handleWatchPendingTransactions() {
  const transactionRequests: Transaction[] = yield select(getLoading)

  const transactions: Transaction[] = yield select(getData)
  const pendingTransactions = transactions.filter(
    transaction => !FINISHED_TYPES.includes(transaction.status)
  )

  const allTransactions = transactionRequests.concat(pendingTransactions)

  for (const tx of allTransactions) {
    if (!watchPendingIndex[tx.hash]) {
      // don't watch transactions that are older than 72 hs
      if (tx.timestamp > Date.now() - 72 * 60 * 60 * 1000)
        yield fork(
          handleFetchTransactionRequest,
          fetchTransactionRequest(tx.from, tx.hash, { type: null })
        )
    }
  }
}

function* handleWatchDroppedTransactions() {
  const transactions: Transaction[] = yield select(getData)
  const droppedTransactions = transactions.filter(
    transaction =>
      transaction.status === txUtils.TRANSACTION_TYPES.dropped &&
      transaction.nonce != null
  )

  for (const tx of droppedTransactions) {
    if (!watchDroppedIndex[tx.hash]) {
      yield fork(
        handleReplaceTransactionRequest,
        replaceTransactionRequest(tx.hash, tx.nonce as number)
      )
    }
  }
}

function* handleConnectWalletSuccess(_: ConnectWalletSuccessAction) {
  yield put(watchPendingTransactions())
  yield put(watchDroppedTransactions())
}
