#!/usr/bin/env bash
# Run all fast (skip_tracing) loan + loan-snpl simulations and print a
# pass/fail summary. Each script self-verifies via _verify.js and exits
# non-zero on hard failure.
set -u

cd "$(dirname "$0")/../.."

SCRIPTS=(
  simulations/fast/simul-jing-loan-sbtc-stx-single.js
  simulations/fast/simul-jing-loan-seize.js
  simulations/fast/simul-jing-loan-repay-stx.js
  simulations/fast/simul-jing-loan-true-happy-path.js
  simulations/fast/simul-jing-loan-rollover.js
  simulations/fast/simul-jing-loan-withdraw-funds.js
  simulations/fast/simul-jing-loan-errors.js
  simulations/fast/simul-jing-loan-serial.js
  simulations/fast/simul-jing-loan-set-swap-limit.js
  simulations/fast/simul-jing-loan-admin.js
  simulations/fast/simul-jing-loan-refund-branch.js
  simulations/fast/simul-jing-loan-reborrow-after-seize.js
  simulations/fast/simul-loan-snpl-happy.js
  simulations/fast/simul-loan-snpl-true-happy.js
  simulations/fast/simul-loan-snpl-seize.js
  simulations/fast/simul-loan-snpl-rollover.js
  simulations/fast/simul-loan-snpl-redeposit.js
  simulations/fast/simul-loan-snpl-multi.js
  simulations/fast/simul-loan-snpl-multi-real-settle.js
  simulations/fast/simul-loan-snpl-set-reserve.js
  simulations/fast/simul-loan-snpl-set-swap-limit.js
  simulations/fast/simul-loan-snpl-repay-refund.js
  simulations/fast/simul-loan-snpl-reborrow-after-seize.js
  simulations/fast/simul-loan-snpl-seize-rolled.js
  simulations/fast/simul-loan-snpl-lender-withdraw-mid-loan.js
)

LOG_DIR="simulations/fast/.logs"
mkdir -p "$LOG_DIR"

declare -a PASS=() FAIL=()

declare -a CERR=() RACE_RETRIED=()

run_one() {
  local script="$1" log="$2"
  npx tsx "$script" > "$log" 2>&1
}

for script in "${SCRIPTS[@]}"; do
  name=$(basename "$script" .js)
  log="$LOG_DIR/$name.log"
  printf "  RUN  %-55s ... " "$name"
  run_one "$script" "$log"
  rc=$?

  # Retry once if stxer's snapshot indexer lagged behind the chain tip.
  if [[ $rc -ne 0 ]] && grep -q "failed to get block info" "$log"; then
    RACE_RETRIED+=("$name")
    sleep 4
    run_one "$script" "$log"
    rc=$?
  fi

  # Brief pause between scripts to avoid Hiro REST API rate-limiting on the
  # Pyth-VAA fetches in the snpl real-settle scripts.
  sleep 2

  if grep -q "RESULT: PASS-WITH-CERR" "$log"; then
    result=$(grep -E "^Steps:" "$log" | tail -1)
    printf "CERR  (%s)\n" "${result#*Steps:}"
    CERR+=("$name")
  elif grep -q "RESULT: PASS" "$log"; then
    result=$(grep -E "^Steps:" "$log" | tail -1)
    printf "PASS  (%s)\n" "${result#*Steps:}"
    PASS+=("$name")
  else
    detail=$(grep -E "Error:|RESULT: FAIL" "$log" | tail -1)
    printf "FAIL  %s\n" "${detail:0:80}"
    FAIL+=("$name")
  fi
done

echo
echo "==================================================================="
echo "Summary (of ${#SCRIPTS[@]} total):"
echo "  PASS:               ${#PASS[@]}"
echo "  PASS-WITH-CERR:     ${#CERR[@]}  (contract returned (err X) on at least one step — verify expected)"
echo "  FAIL:               ${#FAIL[@]}"
[[ ${#RACE_RETRIED[@]} -gt 0 ]] && echo "  retried after race:  ${#RACE_RETRIED[@]}"
echo "Logs: $LOG_DIR/"
echo "==================================================================="

if [[ ${#CERR[@]} -gt 0 ]]; then
  echo "Contract-err scripts (verify the (err X) codes match expected guards):"
  for f in "${CERR[@]}"; do echo "  - $f"; done
fi
if [[ ${#FAIL[@]} -gt 0 ]]; then
  echo "Failures:"
  for f in "${FAIL[@]}"; do echo "  - $f"; done
  exit 1
fi
