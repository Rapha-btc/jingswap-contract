# Clarinet Console Manual Tests

Run: `clarinet console` from the project root.

The console uses simnet with devnet accounts. Mainnet requirements
(sbtc-token, pyth, bitflow) are auto-loaded from `Clarinet.toml`.

## Accounts

```
deployer  = ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM
wallet_1  = ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5
wallet_2  = ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG
wallet_3  = ST2JHG361ZXG51QTKY2NQCVBPPRRE2KZB1HR05NNC
```

## 1. Read initial state

```clarity
(contract-call? .blind-auction get-current-cycle)
;; → u0

(contract-call? .blind-auction get-cycle-phase)
;; → u0 (PHASE_DEPOSIT)

(contract-call? .blind-auction get-min-deposits)
;; → { min-stx: u1000000, min-sbtc: u1000 }

(contract-call? .blind-auction get-dex-price)
;; → should return BTC/STX price from BitFlow XYK pool
```

## 2. Deposit STX (wallet_1)

```clarity
;; Deposit 100 STX
::set_tx_sender ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5
(contract-call? .blind-auction deposit-stx u100000000)
;; → (ok u0)  [cycle 0]

;; Verify
(contract-call? .blind-auction get-stx-deposit u0 'ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5)
;; → u100000000

(contract-call? .blind-auction get-stx-depositors u0)
;; → (list ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5)

(contract-call? .blind-auction get-cycle-totals u0)
;; → { total-stx: u100000000, total-sbtc: u0 }
```

## 3. Deposit sBTC (wallet_2)

```clarity
;; First: wallet_2 needs sBTC. In devnet, deployer has 1M sBTC.
;; Transfer sBTC from deployer to wallet_2:
::set_tx_sender ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM
(contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token transfer u500000 tx-sender 'ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG none)

;; Now deposit 100k sats as wallet_2
::set_tx_sender ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG
(contract-call? .blind-auction deposit-sbtc u100000)
;; → (ok u100000)

;; Verify both sides
(contract-call? .blind-auction get-cycle-totals u0)
;; → { total-stx: u100000000, total-sbtc: u100000 }

(contract-call? .blind-auction get-sbtc-depositors u0)
;; → (list ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG)
```

## 4. Top-up deposit (wallet_1 adds more STX)

```clarity
::set_tx_sender ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5
(contract-call? .blind-auction deposit-stx u50000000)
;; → (ok u0) — adds to existing, no new entry in depositor list

(contract-call? .blind-auction get-stx-deposit u0 'ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5)
;; → u150000000 (100 + 50 STX)
```

## 5. Cancel deposit

```clarity
::set_tx_sender ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5
(contract-call? .blind-auction cancel-stx-deposit)
;; → (ok u150000000) — full refund

(contract-call? .blind-auction get-stx-deposit u0 'ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5)
;; → u0

(contract-call? .blind-auction get-stx-depositors u0)
;; → (list) — empty
```

## 6. Close deposits + settle (advance blocks)

```clarity
;; Re-deposit for settlement test
::set_tx_sender ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5
(contract-call? .blind-auction deposit-stx u100000000)

;; Advance 150+ blocks to pass DEPOSIT_MIN_BLOCKS
::advance_chain_tip 160

;; Close deposits (anyone can call)
(contract-call? .blind-auction close-deposits)
;; → (ok true)

(contract-call? .blind-auction get-cycle-phase)
;; → u1 (PHASE_BUFFER)

;; Advance past buffer (30 blocks)
::advance_chain_tip 35

(contract-call? .blind-auction get-cycle-phase)
;; → u2 (PHASE_SETTLE)

;; Settle using stored Pyth prices
(contract-call? .blind-auction settle)
;; → might fail with ERR_STALE_PRICE (u1005) in simnet
;; If so, you'd need settle-with-refresh with Pyth VAAs
```

## 7. Admin functions (as deployer)

```clarity
::set_tx_sender ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM

;; Pause
(contract-call? .blind-auction set-paused true)
;; → (ok true)

;; Try deposit while paused — should fail
::set_tx_sender ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5
(contract-call? .blind-auction deposit-stx u1000000)
;; → (err u1010) ERR_PAUSED

;; Unpause
::set_tx_sender ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM
(contract-call? .blind-auction set-paused false)

;; Change min deposits
(contract-call? .blind-auction set-min-stx-deposit u5000000)
;; → (ok true) — now 5 STX minimum

;; Switch DEX source
(contract-call? .blind-auction set-dex-source u2)
;; → (ok true) — DLMM
```

## 8. Error cases

```clarity
;; Deposit too small
::set_tx_sender ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5
(contract-call? .blind-auction deposit-stx u100)
;; → (err u1001) ERR_DEPOSIT_TOO_SMALL

;; Close too early
(contract-call? .blind-auction close-deposits)
;; → (err u1015) ERR_CLOSE_TOO_EARLY

;; Non-owner admin call
::set_tx_sender ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5
(contract-call? .blind-auction set-paused true)
;; → (err u1011) ERR_NOT_AUTHORIZED
```
