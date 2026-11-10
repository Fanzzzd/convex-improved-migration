#!/bin/bash
# End-to-end checks on real local Convex backends, for behaviour convex-test
# does not simulate: transaction limits, the 1 s user-code limit, the write
# throttle, the background driver and its watchdog, CLI exit codes, and
# snapshot import detection.
#
# Usage: ./e2e.sh   Uses two anonymous local deployments: A (this folder)
# and B (./b, same functions). Every run starts both from an empty state.
# E2E_PORT (default 3510) is the backend port; one backend runs at a time.
# E2E_LONG=1 adds a run of more than five minutes through the CLI.
set -uo pipefail
cd "$(dirname "$0")"
export CONVEX_AGENT_MODE=anonymous
PORT=${E2E_PORT:-3510}

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; exit 1; }
# Run a function on A or B. Stdout is the JSON result; stderr goes to $ERR.
ERR=$(mktemp)
OUT=$(mktemp)
runA() { npx convex run "$@" 2>"$ERR"; }
runB() { (cd b && npx convex run "$@" 2>"$ERR"); }
# The command line program, from the installed tarball. Output goes to $OUT.
cli() { npx convex-improved-migration "$@" >"$OUT" 2>&1; }
field() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d);console.log(JSON.stringify($1))})"; }
wait_run() { # $1 = module, $2 = tries of 2 s; waits until no run holds the Lease
  for _ in $(seq 1 "${2:-60}"); do
    [ "$(runA "$1:status" | field 'r.run')" = "null" ] && return 0
    sleep 2
  done
  return 1
}
events() { # $1 = Step id or "(run)"; prints a JSON array of "type: detail"
  npx convex run migrations:status "{\"events\":\"$1\"}" 2>"$ERR" | field 'r.events.map(e=>e.type+": "+(e.detail??""))'
}

echo "== package and push"
(cd .. && npm run build:clean >/dev/null && rm -rf e2e/.pack && mkdir -p e2e/.pack \
  && npm pack --pack-destination e2e/.pack >/dev/null \
  && mv e2e/.pack/convex-improved-migration-*.tgz e2e/.pack/convex-improved-migration.tgz) \
  || fail "build and pack"
rm -rf node_modules/convex-improved-migration package-lock.json
npm install --no-audit --no-fund >/dev/null || fail "npm install"
[ -x node_modules/.bin/convex-improved-migration ] || fail "the tarball installs the convex-improved-migration bin"

# Start both deployments empty, so an older schema's rows cannot block the
# push, and keep them on $PORT, away from other projects' backends.
for d in . b; do
  rm -rf "$d/.convex/local/default/convex_local_backend.sqlite3" "$d/.convex/local/default/convex_local_storage"
  cfg="$d/.convex/local/default/config.json"
  [ -f "$cfg" ] && node -e "const f='$cfg',fs=require('fs');const c=JSON.parse(fs.readFileSync(f));c.ports={cloud:$PORT,site:$((PORT+1))};fs.writeFileSync(f,JSON.stringify(c))"
done
DEV_PID=""
LOG=$(mktemp)
HERE=$(pwd -P)
start_dev() { # $1 = directory (. or b)
  stop_dev
  (cd "$1" && exec npx convex dev --typecheck disable --tail-logs disable \
    --local-cloud-port "$PORT" --local-site-port $((PORT+1)) >"$LOG" 2>&1) &
  DEV_PID=$!
  for _ in $(seq 1 90); do
    grep -q "Convex functions ready" "$LOG" && return 0
    kill -0 "$DEV_PID" 2>/dev/null || break
    sleep 1
  done
  cat "$LOG"; fail "convex dev did not become ready in $1"
}
stop_dev() {
  if [ -n "$DEV_PID" ]; then
    pkill -P "$DEV_PID" 2>/dev/null; kill "$DEV_PID" 2>/dev/null; wait "$DEV_PID" 2>/dev/null
    DEV_PID=""
  fi
  # The local backend detaches from `convex dev`. Stop it only if it serves
  # one of this folder's deployments; never touch another project's backend.
  for pid in $(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null); do
    cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
    case "$cwd" in
      "$HERE"|"$HERE"/*) kill "$pid" ;;
      *) echo "Port $PORT is used by another project's backend ($cwd). Set E2E_PORT."; exit 1 ;;
    esac
  done
  for _ in $(seq 1 30); do lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 1; done
}
trap stop_dev EXIT

python3 -c "import zipfile; zipfile.ZipFile('empty.zip','w').close()"
start_dev b
(cd b && npx convex import --replace-all -y ../empty.zip >/dev/null 2>&1) || fail "reset B"
start_dev .
npx convex import --replace-all -y empty.zip >/dev/null 2>&1 || fail "reset A"
st=$(runA migrations:status | field 'r.steps.map(s=>s.state)')
[ "$st" = '["pending","pending"]' ] || fail "an empty --replace-all import clears component state too (got $st)"
pass "an empty --replace-all import clears component state too"

echo "== timers in actions"
ms=$(runA data:timer '{"ms":500}') || fail "timer action ($(tail -3 "$ERR"))"
[ "$ms" -ge 450 ] || fail "an action waited only ${ms} ms on a 500 ms timer"
pass "an action can wait on a timer (${ms} ms for 500 ms), which the throttle backoff needs"

echo "== real transaction limits"
for i in 0 1 2 3 4 5 6 7; do runA data:addItems "{\"from\":$((i*20)),\"count\":20,\"payloadKb\":150}" >/dev/null || fail "seed items"; done
cli apply || { cat "$OUT"; fail "CLI apply on 160 x 150 KB items exits 0"; }
grep -q "^Done in" "$OUT" || { cat "$OUT"; fail "CLI apply prints Done"; }
shrinks=$(events touch-items | field 'r.filter(e=>e.startsWith("batch shrunk")).map(e=>e.split(": ")[1])')
[ "$shrinks" != "[]" ] || fail "expected batch shrunk events"
pass "the batch shrank on real limits ($shrinks) and finished"
echo "    limit messages seen: $(events touch-items | field '[...new Set(r.filter(e=>e.startsWith("batch shrunk")).map(e=>e.split(": ").slice(2).join(": ").slice(0,90)))]')"
[ "$(runA data:itemCount)" = "160" ] || fail "item-count rebuild"
pass "rebuild cleared and recomputed item-count"

echo "== failures exit non-zero and resume"
runA migrations:operate '{"op":"reset","id":"touch-items"}' >/dev/null
runA data:untouch '{"ns":[7]}' >/dev/null
runA data:setFlag '{"name":"fail","on":true}' >/dev/null
if runA migrations:apply >/dev/null; then fail "a failing apply function must exit non-zero"; fi
grep -q 'refusing item 7' "$ERR" || fail "error names the cause"
grep -q 'convex-improved-migration mark-done touch-items' "$ERR" || fail "error prints the next commands"
pass "a failing apply function exits non-zero with the cause and next commands"
cli check; [ $? -eq 1 ] || { cat "$OUT"; fail "check exits 1 while a Step failed"; }
pass "check exits 1 while a Step failed"
cli apply; [ $? -eq 1 ] || { cat "$OUT"; fail "CLI apply exits 1 when a Step fails"; }
grep -q 'refusing item 7' "$OUT" || { cat "$OUT"; fail "CLI apply prints the cause"; }
pass "CLI apply exits 1 with the cause when a Step fails"
cli apply --dry-run || { cat "$OUT"; fail "CLI apply --dry-run exits 0 while a Step failed"; }
grep -q 'dry-run batch threw: refusing item 7' "$OUT" || { cat "$OUT"; fail "the dry run names the cause"; }
if grep -qE 'Uncaught|^ +at ' "$OUT"; then cat "$OUT"; fail "the dry run prints the cause without the runtime prefix or stack lines"; fi
pass "the dry run of a failed Step names the cause in one line"
runA data:setFlag '{"name":"fail","on":false}' >/dev/null
cli apply || { cat "$OUT"; fail "CLI apply after the fix"; }
pass "CLI apply after the fix resumes and exits 0"

echo "== the 1 s user-code limit in the background driver"
runA migrations:operate '{"op":"reset","id":"touch-items"}' >/dev/null
runA data:untouch '{"ns":[8]}' >/dev/null
runA data:setFlag '{"name":"slow","on":true}' >/dev/null
cli apply --no-wait || { cat "$OUT"; fail "CLI apply --no-wait"; }
wait_run migrations || fail "the background run ended"
state=$(runA migrations:status | field 'r.steps[0].state+" | "+r.steps[0].error.message')
echo "    recorded: $state"
case "$state" in \"failed*"timed out"*) ;; *) fail "the time-limit abort is recorded on the Step";; esac
pass "an outer abort in the background driver is recorded on the Step"
runA data:setFlag '{"name":"slow","on":false}' >/dev/null
cli apply || { cat "$OUT"; fail "apply after the time-limit fix"; }

echo "== Still Running hands the run to the background"
if runA slow:apply >/dev/null; then fail "apply past its budget must exit non-zero"; fi
grep -q 'Still running: run [a-z0-9]* continues in the background' "$ERR" || fail "Still Running message ($(tail -3 "$ERR"))"
grep -q "Keep waiting with: npx convex run slow:apply '{\"resume\":" "$ERR" || fail "Still Running names the resume call ($(tail -3 "$ERR"))"
pass "an apply function past its budget throws Still Running with the run id"
wait_run slow || fail "the handed-off run ended"
[ "$(runA slow:status | field 'r.state')" = '"done"' ] || fail "the handed-off run finished"
[ "$(runA data:counts | field 'r.withPayload')" = "0" ] || fail "every payload removed"
pass "the handed-off run finished in the background"

echo "== CLI --timeout and takeover"
runA migrations:operate '{"op":"reset","id":"touch-items"}' >/dev/null
for i in 0 1 2 3; do runA data:addItems "{\"from\":$((1000+i*500)),\"count\":500,\"payloadKb\":0}" >/dev/null || fail "seed lag items"; done
runA data:setFlag '{"name":"lag","on":true}' >/dev/null
cli apply --timeout 2s; code=$?
[ $code -eq 2 ] || { cat "$OUT"; fail "CLI apply --timeout exits 2 while the run continues (got $code)"; }
pass "CLI apply --timeout exits 2 while the run continues"
cli apply || { cat "$OUT"; fail "a second apply takes over and finishes"; }
[ "$(runA data:counts | field 'r.touched===r.total')" = "true" ] || fail "every item touched"
pass "a second apply took over the run and finished it"

echo "== the watchdog restarts a background driver lost to a backend restart"
runA migrations:operate '{"op":"reset","id":"touch-items"}' >/dev/null
for i in $(seq 0 9); do runA data:addItems "{\"from\":$((10000+i*300)),\"count\":300,\"payloadKb\":0}" >/dev/null || fail "seed lag items"; done
cli apply --no-wait || { cat "$OUT"; fail "CLI apply --no-wait"; }
sleep 4
before=$(runA migrations:status | field 'r.steps[0].state+" "+r.steps[0].processed')
case "$before" in \"running*) ;; *) fail "the run is mid-way before the restart (got $before)";; esac
echo "    before the restart: $before"
start_dev .
wait_run migrations 150 || fail "the run ended after the restart (run events $(events '(run)'))"
[ "$(runA migrations:status | field 'r.state')" = '"done"' ] || fail "the run finished after the restart"
run_events=$(events "(run)")
case "$run_events" in *restarted*) ;; *) fail "expected a watchdog restart event: $run_events";; esac
echo "    run events: $run_events"
[ "$(runA data:counts | field 'r.touched===r.total')" = "true" ] || fail "every item touched"
pass "the watchdog restarted the lost driver and the run finished"

echo "== snapshot import is detected and Rebuilds run again"
runA data:setFlag '{"name":"lag","on":false}' >/dev/null
out=$(runA migrations:apply) || fail "apply on A ($(tail -3 "$ERR"))"
[ "$(echo "$out" | field 'r.restored')" = "false" ] || fail "A is not restored"
rm -f snap.zip; npx convex export --path snap.zip >"$ERR" 2>&1 || fail "export A ($(tail -5 "$ERR"))"
total=$(runA data:counts | field 'r.total')
# Into another deployment.
start_dev b
(cd b && npx convex import --replace-all -y ../snap.zip >/dev/null 2>&1) || fail "import into B"
runB data:wipe '{"table":"itemCount"}' >/dev/null
# Before any apply: status says so, the Rebuild reads as pending, check fails.
st=$(runB migrations:status | field '[r.importSuspected, r.steps.map(s=>s.state), r.steps[1].reason]')
[ "$st" = '[true,["done","pending"],"snapshot import suspected; apply rebuilds it"]' ] || fail "status on B before apply: $st"
(cd b && ../node_modules/.bin/convex-improved-migration check >"$OUT" 2>&1); [ $? -eq 1 ] || { cat "$OUT"; fail "check exits 1 on B before apply"; }
(cd b && ../node_modules/.bin/convex-improved-migration status >"$OUT" 2>&1)
grep -q '^Snapshot import suspected' "$OUT" || { cat "$OUT"; fail "CLI status names the suspected import"; }
pass "status and check report the suspected import on B before any apply"
out=$(runB migrations:apply) || fail "apply on B ($(tail -3 "$ERR"))"
[ "$(echo "$out" | field 'r.restored')" = "true" ] || fail "B detects the import: $out"
[ "$(runB data:itemCount)" = "$total" ] || fail "B rebuilt item-count"
pass "B detected the snapshot import and rebuilt item-count"
[ "$(runB migrations:status | field 'r.importSuspected')" = "false" ] || fail "no import suspected on B after apply"
(cd b && ../node_modules/.bin/convex-improved-migration check >"$OUT" 2>&1) || { cat "$OUT"; fail "check exits 0 on B after apply"; }
pass "after apply on B no import is suspected and check exits 0"
[ "$(runB migrations:apply | field 'r.restored')" = "false" ] || fail "second apply on B is not a restore"
pass "a later apply on B does not report a restore"
# Back into the same deployment, after another apply there.
start_dev .
[ "$(runA migrations:apply | field 'r.restored')" = "false" ] || fail "A is still not restored"
[ "$(runA migrations:status | field 'r.importSuspected')" = "false" ] || fail "no import suspected on A before the import"
npx convex import --replace-all -y snap.zip >/dev/null 2>&1 || fail "import into A"
runA data:wipe '{"table":"itemCount"}' >/dev/null
[ "$(runA migrations:status | field 'r.importSuspected')" = "true" ] || fail "status on A reports its own older snapshot"
cli check; [ $? -eq 1 ] || { cat "$OUT"; fail "check exits 1 on A after importing its own snapshot"; }
pass "status and check report A's own older snapshot before any apply"
out=$(runA migrations:apply) || fail "apply on A after the import ($(tail -3 "$ERR"))"
[ "$(echo "$out" | field 'r.restored')" = "true" ] || fail "A detects its own snapshot: $out"
[ "$(runA data:itemCount)" = "$total" ] || fail "A rebuilt item-count"
pass "A detected its own older snapshot and rebuilt item-count"

echo "== CLI apply with no convex dev running (a setup script)"
# An anonymous local backend only runs while a CLI command runs. The CLI
# must keep it up for the whole run.
stop_dev
runA migrations:operate '{"op":"reset","id":"touch-items"}' >/dev/null || fail "reset without convex dev ($(tail -3 "$ERR"))"
for i in 0 1 2 3; do runA data:addItems "{\"from\":$((50000+i*500)),\"count\":500,\"payloadKb\":0}" >/dev/null || fail "seed items"; done
runA data:setFlag '{"name":"lag","on":true}' >/dev/null
lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && fail "no backend should be running between commands"
t0=$(date +%s)
cli apply || { cat "$OUT"; fail "CLI apply with no convex dev exits 0"; }
[ "$(runA migrations:status | field '[r.state, r.steps.map(s=>s.state)]')" = '["done",["done","done"]]' ] || fail "every Step done"
[ "$(runA data:counts | field 'r.touched===r.total')" = "true" ] || fail "every item touched"
pass "CLI apply with no convex dev ran 2000 slow documents in $(( $(date +%s) - t0 ))s and exited 0"
runA migrations:operate '{"op":"reset","id":"touch-items"}' >/dev/null
runA data:untouch '{"ns":[7]}' >/dev/null
runA data:setFlag '{"name":"fail","on":true}' >/dev/null
cli apply; [ $? -eq 1 ] || { cat "$OUT"; fail "CLI apply with no convex dev exits 1 on a failing Step"; }
grep -q 'refusing item 7' "$OUT" || { cat "$OUT"; fail "the failure names the cause"; }
pass "CLI apply with no convex dev exits 1 on a failing Step"
runA data:setFlag '{"name":"fail","on":false}' >/dev/null
runA data:setFlag '{"name":"lag","on":false}' >/dev/null
cli apply || { cat "$OUT"; fail "CLI apply with no convex dev after the fix"; }
pass "CLI apply with no convex dev resumes after the fix and exits 0"

echo "== the background driver under the 4 MiB/s write throttle"
start_dev .
t0=$(date +%s)
cli apply --module burst --no-wait || { cat "$OUT"; fail "CLI apply --no-wait of about 144 MB of writes"; }
burst_run=$(sed -n 's/^Started run \([a-z0-9]*\)\./\1/p' "$OUT")
[ -n "$burst_run" ] || { cat "$OUT"; fail "the run id is printed"; }
wait_run burst 150 || fail "the burst run ended"
[ "$(runA burst:status | field 'r.state')" = '"done"' ] || fail "the burst run finished: $(runA burst:status | field 'r.steps[0]')"
throttled=$(runA burst:status '{"events":"burst-writes"}' | field 'r.events.map(e=>e.type+": "+(e.detail??"")).filter(e=>e.startsWith("write throttled"))')
[ "$throttled" != "[]" ] || fail "expected write throttled events"
echo "    $(echo "$throttled" | field 'r.length') backoff event(s), for example $(echo "$throttled" | field 'r[r.length-1].slice(0,140)')"
run_events=$(runA burst:status '{"events":"(run)"}' | field "r.events.filter(e=>e.runId==='$burst_run').map(e=>e.type)")
[ "$run_events" = "[]" ] || fail "no watchdog restart or stall in run $burst_run: $run_events"
pass "the background driver backed off on the write throttle and finished in $(( $(date +%s) - t0 ))s with no restart or stall"

echo "== .paginate() inside clear and run"
out=$(runA paginate:apply '{"only":"clear-paginates"}') || fail "a clear function that paginates once ($(tail -3 "$ERR"))"
[ "$(runA data:itemCount)" = "3" ] || fail "clear-paginates cleared and recounted the 3 flags (got $(runA data:itemCount))"
pass "a clear function may call .paginate()"
# convex-test allows one paginated query per function. A real backend
# accepts several in one mutation, so these two also work.
runA paginate:operate '{"op":"reset","id":"clear-paginates"}' >/dev/null
out=$(runA paginate:apply '{"dryRun":true,"only":"clear-paginates"}') || fail "dry run of clear-paginates ($(tail -3 "$ERR"))"
why=$(echo "$out" | field 'r.steps[0].reason')
case "$why" in *"preview includes the clear"*) ;; *) fail "dry run of a paginating clear: $why";; esac
[ "$(echo "$out" | field 'r.orphans.map(o=>o.id).includes("run-paginates")')" = "false" ] || fail "only must not list other Plan Steps as Orphans"
pass "the Dry Run of a paginating clear runs clear and the Batch in one transaction"
out=$(runA paginate:apply '{"only":"run-paginates"}') || fail "a run function that paginates ($(tail -3 "$ERR"))"
[ "$(echo "$out" | field 'r.steps[0].state')" = '"done"' ] || fail "run-paginates is done: $out"
pass "a real backend accepts .paginate() in run, beside the Batch's own paginated query"
runA paginate:apply >/dev/null || fail "finish the paginate Plan ($(tail -3 "$ERR"))"

echo "== the CLI waits through Still Running on the same run"
# The slow Plan hands over after every unit of work, so the CLI needs several
# apply calls. They must be one run: the Seed runs once.
runA slow:operate '{"op":"reset","id":"slow-untouch"}' >/dev/null
# The burst Plan left a 900 KB payload on 160 items, for slow-untouch to remove.
before=$(runA data:seedRuns '{"name":"slow-seed"}')
cli apply --module slow || { cat "$OUT"; fail "CLI apply through Still Running exits 0"; }
grep -q "^Done in" "$OUT" || { cat "$OUT"; fail "CLI apply through Still Running prints Done"; }
[ "$(runA slow:status | field '[r.state, r.run]')" = '["done",null]' ] || fail "the slow Plan is done"
[ "$(runA data:counts | field 'r.withPayload')" = "0" ] || fail "every payload removed"
after=$(runA data:seedRuns '{"name":"slow-seed"}')
[ "$after" = "$((before + 1))" ] || fail "the Seed ran $((after - before)) times in one CLI apply"
rid=$(runA slow:status | field 'r.steps[1].runId')
taken=$(runA slow:status '{"events":"(run)"}' | field "r.events.filter(e=>e.type==='taken back'&&JSON.stringify(e.runId)===JSON.stringify($rid)).length")
[ "$taken" -ge 1 ] || fail "expected the CLI to come back for run $rid at least once"
pass "one CLI apply came back for run $rid $taken time(s); its Seed ran once"

echo "== operator commands against a driver that writes after every document"
runA data:addItems '{"from":90000,"count":3000,"payloadKb":0}' >/dev/null || fail "seed the busy items"
runA busy:apply '{"wait":false}' >/dev/null || fail "start the busy run ($(tail -3 "$ERR"))"
sleep 2
cli reset busy-touch --module busy; code=$?
[ "$code" -eq 1 ] && grep -q "^Refusing to reset \"busy-touch\": a run is working on it" "$OUT" \
  || { cat "$OUT"; fail "reset of a Step a busy driver works on is refused with the friendly text (exit $code)"; }
for try in 1 2 3; do
  [ "$try" = 1 ] || { runA busy:apply '{"wait":false}' >/dev/null || fail "restart the busy run ($(tail -3 "$ERR"))"; sleep 2; }
  cli cancel --module busy || { cat "$OUT"; fail "CLI cancel against a busy driver exits 0 (try $try)"; }
  grep -q "^Canceled" "$OUT" || { cat "$OUT"; fail "CLI cancel says Canceled (try $try)"; }
  wait_run busy 30 || fail "the canceled busy run stopped (try $try)"
  st=$(runA busy:status | field '[r.steps[0].state, r.steps[0].reason]')
  [ "$st" = '["pending","canceled; apply resumes it"]' ] || fail "busy-touch is canceled after try $try: $st"
done
pass "reset was refused and three cancels stopped a driver at batch size 1"
# One Plan per component mount: a canceled Step of this Plan would block the
# next module's apply as an unfinished Step removed from its Plan.
cli mark-done busy-touch --reason "busy checks done" --module busy || { cat "$OUT"; fail "mark-done of the canceled busy Step exits 0"; }
[ "$(runA busy:status | field 'r.steps[0].state')" = '"done"' ] || fail "busy-touch is done after mark-done"
pass "mark-done recorded the canceled busy Step"

if [ "${E2E_LONG:-}" = "1" ]; then
  echo "== a run longer than the 300 s limit of convex run (E2E_LONG=1)"
  t0=$(date +%s)
  cli apply --module long || { cat "$OUT"; fail "CLI apply over five minutes exits 0"; }
  took=$(( $(date +%s) - t0 ))
  grep -q "^Done in" "$OUT" || { cat "$OUT"; fail "CLI apply over five minutes prints Done"; }
  [ "$took" -gt 300 ] || fail "the long run took only ${took}s, not more than 300 s"
  # The crawl stops adding ticks after 310 s. Far longer means a slow driver.
  [ "$took" -lt 900 ] || fail "the long run took ${took}s, expected about 320 s"
  [ "$(runA data:seedRuns '{"name":"long-seed"}')" = "1" ] || fail "the Seed of the long run ran once"
  rid=$(runA long:status | field 'r.steps[1].runId')
  taken=$(runA long:status '{"events":"(run)"}' | field "r.events.filter(e=>e.type==='taken back'&&JSON.stringify(e.runId)===JSON.stringify($rid)).length")
  [ "$taken" -ge 1 ] || fail "expected the CLI to come back for run $rid at least once"
  pass "CLI apply waited ${took}s for one run over $((taken + 1)) apply calls and exited 0; its Seed ran once"
else
  echo "== skipped: a run longer than 300 s (set E2E_LONG=1; adds about six minutes)"
fi

rm -f "$ERR" "$OUT" "$LOG" empty.zip snap.zip
echo "ALL E2E CHECKS PASSED"
