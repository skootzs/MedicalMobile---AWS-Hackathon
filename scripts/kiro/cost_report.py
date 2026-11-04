"""Prints spend to date and Bedrock tokens per run. Driven by 32-cost-report.sh.

Uses the AWS CLI, so it needs no Python packages. Only reads.
"""
import json
import os
import subprocess
import sys
from datetime import date, datetime, timedelta, timezone

TAG_KEY = "project"
TAG_VALUE = "cht-nocode"
REGION = os.environ.get("AWS_REGION", "us-west-2")


def aws(*args, region=REGION):
    """Runs an AWS CLI command and returns parsed JSON. Raises RuntimeError on failure."""
    result = subprocess.run(
        ["aws", *args, "--region", region, "--output", "json"], capture_output=True, text=True, check=False
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip().splitlines()[-1] if result.stderr.strip() else "unknown error")
    return json.loads(result.stdout) if result.stdout.strip() else {}


def start_date():
    configured = os.environ.get("COST_START")
    if configured:
        return date.fromisoformat(configured)
    return (date.today().replace(day=1) - timedelta(days=1)).replace(day=1)


def cost_by_service(start, end, tag_filter):
    """Returns ({service: amount}, unit), adding up every page and month of results."""
    args = [
        "ce", "get-cost-and-usage",
        "--time-period", f"Start={start},End={end}",
        "--granularity", "MONTHLY",
        "--metrics", "UnblendedCost",
        "--group-by", "Type=DIMENSION,Key=SERVICE",
    ]
    if tag_filter:
        args += ["--filter", json.dumps({"Tags": {"Key": TAG_KEY, "Values": [TAG_VALUE]}})]
    totals, unit = {}, "USD"
    # Cost Explorer's API lives in us-east-1 whichever region the resources are in.
    for period in aws(*args, region="us-east-1").get("ResultsByTime", []):
        for group in period.get("Groups", []):
            metric = group["Metrics"]["UnblendedCost"]
            totals[group["Keys"][0]] = totals.get(group["Keys"][0], 0.0) + float(metric["Amount"])
            unit = metric["Unit"]
    return totals, unit


def print_costs(title, totals, unit):
    print(title)
    if not totals:
        print("  (no cost recorded)")
    for service, amount in sorted(totals.items(), key=lambda item: -item[1]):
        if amount >= 0.005:
            print(f"  {amount:10.2f} {unit}  {service}")
    print(f"  {sum(totals.values()):10.2f} {unit}  TOTAL")


def report_spend(start, end):
    """Prints spend. Returns tagged and account totals, each None if unavailable."""
    print(f"== Spend {start} to {end} (Cost Explorer, about a day behind) ==")
    tagged_total = account_total = None
    try:
        totals, unit = cost_by_service(start, end, tag_filter=True)
        print_costs(f"Tagged {TAG_KEY}={TAG_VALUE}:", totals, unit)
        tagged_total = sum(totals.values())
        if not totals:
            print(f"  A zero here can mean {TAG_KEY} isn't activated as a cost allocation tag in Billing.")
    except RuntimeError as err:
        print(f"Tagged spend unavailable: {err}")
    try:
        totals, unit = cost_by_service(start, end, tag_filter=False)
        print_costs("Whole account (includes untagged usage and any non-project resources):", totals, unit)
        account_total = sum(totals.values())
    except RuntimeError as err:
        print(f"Account spend unavailable: {err}")
    print("Bedrock calls through shared inference profiles aren't tagged, so compare the Bedrock line above.")
    return tagged_total, account_total


def report_tokens(start, end):
    """Prints per-model tokens from AWS/Bedrock CloudWatch metrics. Returns totals or None."""
    print(f"\n== Bedrock tokens in {REGION} (CloudWatch metrics) ==")
    totals = {"InputTokenCount": 0.0, "OutputTokenCount": 0.0, "Invocations": 0.0}
    try:
        listed = aws("cloudwatch", "list-metrics", "--namespace", "AWS/Bedrock", "--metric-name", "Invocations")
        models = sorted({
            dimension["Value"]
            for metric in listed.get("Metrics", [])
            for dimension in metric.get("Dimensions", [])
            if dimension["Name"] == "ModelId"
        })
        if not models:
            print("  No Bedrock invocations recorded (CloudWatch keeps metrics listed for 2 weeks).")
        start_time = datetime(start.year, start.month, start.day, tzinfo=timezone.utc).isoformat()
        end_time = datetime(end.year, end.month, end.day, tzinfo=timezone.utc).isoformat()
        for model in models:
            row = {}
            for name in totals:
                stats = aws(
                    "cloudwatch", "get-metric-statistics", "--namespace", "AWS/Bedrock", "--metric-name", name,
                    "--dimensions", f"Name=ModelId,Value={model}", "--start-time", start_time, "--end-time", end_time,
                    "--period", "86400", "--statistics", "Sum",
                )
                row[name] = sum(point["Sum"] for point in stats.get("Datapoints", []))
                totals[name] += row[name]
            print(f"  {model}: {row['Invocations']:.0f} calls, {row['InputTokenCount']:.0f} in, {row['OutputTokenCount']:.0f} out")
        print(f"  TOTAL: {totals['Invocations']:.0f} calls, {totals['InputTokenCount']:.0f} in, {totals['OutputTokenCount']:.0f} out")
        return totals
    except RuntimeError as err:
        print(f"Bedrock metrics unavailable: {err}")
        return None


def report_invocation_logs():
    """Says whether per-call invocation logs exist, since those give finer evidence."""
    print("\n== Bedrock invocation logging ==")
    try:
        config = aws("bedrock", "get-model-invocation-logging-configuration").get("loggingConfig") or {}
    except RuntimeError as err:
        print(f"Unavailable: {err}")
        return
    log_group = (config.get("cloudWatchConfig") or {}).get("logGroupName")
    if not log_group:
        print("Not enabled to CloudWatch Logs, so tokens above come from metrics only.")
        return
    now = int(datetime.now(timezone.utc).timestamp())
    query = "stats sum(input.inputTokenCount) as inputTokens, sum(output.outputTokenCount) as outputTokens, count(*) as calls by modelId"
    try:
        started = aws(
            "logs", "start-query", "--log-group-name", log_group, "--start-time", str(now - 30 * 86400),
            "--end-time", str(now), "--query-string", query,
        )
        for _ in range(30):
            result = aws("logs", "get-query-results", "--query-id", started["queryId"])
            if result.get("status") in ("Complete", "Failed", "Cancelled"):
                break
            subprocess.run(["sleep", "2"], check=False)
        print(f"Last 30 days from {log_group} ({result.get('status')}):")
        for row in result.get("results", []):
            print("  " + ", ".join(f"{field['field']}={field['value']}" for field in row))
    except RuntimeError as err:
        print(f"Log query unavailable: {err}")


def count_items(table, expression, values):
    """Counts matching items. The CLI follows pagination, so this covers the whole table."""
    args = [
        "dynamodb", "scan", "--table-name", table, "--select", "COUNT",
        "--filter-expression", expression, "--expression-attribute-values", json.dumps(values),
    ]
    return int(aws(*args).get("Count", 0))


def report_per_run(table, tokens, tagged_total, account_total):
    """Prints runs and per-run figures. Returns False if the run count was unavailable."""
    print("\n== Per run (a run is one request in the table) ==")
    try:
        meta = {":meta": {"S": "META"}}
        runs = count_items(table, "begins_with(pk, :p) AND sk = :meta", {":p": {"S": "REQ#"}, **meta})
        jobs = count_items(table, "begins_with(pk, :p) AND sk = :meta", {":p": {"S": "JOB#"}, **meta})
    except RuntimeError as err:
        print(f"Run count unavailable: {err}")
        return False
    print(f"  Runs: {runs}. Jobs: {jobs}.")
    if runs == 0:
        print("  No runs yet, so there's nothing to divide by.")
        return True
    if tokens:
        print(f"  Tokens per run: {tokens['InputTokenCount'] / runs:.0f} in, {tokens['OutputTokenCount'] / runs:.0f} out")
    # Spend is a ceiling per run: it includes hosts and storage idle between runs.
    if tagged_total is not None:
        print(f"  Tagged spend per run (all fixed costs included): {tagged_total / runs:.2f} USD")
    if account_total is not None:
        print(f"  Account spend per run (all fixed costs included): {account_total / runs:.2f} USD")
    return True


def main():
    table = sys.argv[1]
    start = start_date()
    # Cost Explorer and CloudWatch treat the end date as exclusive, so this includes today.
    end = date.today() + timedelta(days=1)
    tagged_total, account_total = report_spend(start, end)
    tokens = report_tokens(start, end)
    report_invocation_logs()
    runs_known = report_per_run(table, tokens, tagged_total, account_total)
    missing = [
        name
        for name, ok in (
            ("spend", tagged_total is not None or account_total is not None),
            ("tokens", tokens is not None),
            ("run count", runs_known),
        )
        if not ok
    ]
    print()
    if len(missing) == 3:
        print("RESULT: FAIL no section could read its data, check the credentials")
        return 1
    print(f"RESULT: PASS report printed{', missing: ' + ', '.join(missing) if missing else ''}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
