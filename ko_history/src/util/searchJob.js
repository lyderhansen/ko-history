/*
 * Async Splunk search-job runner: create, poll to completion, fetch results.
 *
 * Replaces `exec_mode=oneshot`, which blocks server-side until the search
 * finishes. Since `fetch` has no default timeout, a slow search left the
 * promise pending forever and the wrapper's spinner never resolved. Selecting
 * another KO aborted that request and issued a fresh one, which is why the
 * symptom looked like "you have to click it twice".
 *
 * Transport is injected (`fetchImpl`, `sleep`) so the state machine is testable
 * in node without timers or a live Splunk. CommonJS to match the other
 * node-tested utils here (koClass, koRestoreParse, palette, versionSearchTerms);
 * webpack imports it from ESM without ceremony.
 */

var POLL_START_MS = 250;
var POLL_CAP_MS = 2000;
var POLL_FACTOR = 1.5;
// ~20 minutes at the capped interval. The caller's abort signal is the real
// bound; this only stops a wedged job from polling forever.
var DEFAULT_MAX_POLLS = 600;

function nextDelay(prev) {
    return Math.min(Math.round(prev * POLL_FACTOR), POLL_CAP_MS);
}

function abortError() {
    var e = new Error('aborted');
    e.name = 'AbortError';
    return e;
}

function aborted(signal) {
    return !!(signal && signal.aborted);
}

// Transport-level hiccups between splunkweb and splunkd. A poll that hits one
// of these says nothing about the search itself, so it is worth retrying;
// 401/403/404 are real answers and are not.
var RETRYABLE_STATUS = [429, 500, 502, 503, 504];
// Transient poll failures tolerated per job before giving up.
var MAX_TRANSIENT_RETRIES = 3;

// Resolve a response to JSON, preserving the error shape callers already match on.
//
// Parses via text() rather than resp.json() because the results endpoint answers
// 204 No Content with an empty body when a job produced no rows. resp.json() on
// an empty body rejects with "Unexpected end of JSON input", which would surface
// a parser message in the UI for the perfectly normal "this KO has no versions"
// case. Returns null for an empty body; callers treat that as no rows.
function okJson(resp) {
    if (!resp.ok) {
        return resp.text().then(function (t) {
            var err = new Error('search HTTP ' + resp.status + ' ' + String(t).slice(0, 200));
            err.status = resp.status;
            err.retryable = RETRYABLE_STATUS.indexOf(resp.status) !== -1;
            return Promise.reject(err);
        });
    }
    if (resp.status === 204) return Promise.resolve(null);
    return resp.text().then(function (t) {
        if (!t) return null;
        try {
            return JSON.parse(t);
        } catch (e) {
            return Promise.reject(new Error('search returned an unparseable response'));
        }
    });
}

// Pull the job status out of a jobs/<sid> entry payload.
function jobStatus(json) {
    var entry = json && json.entry && json.entry[0];
    var c = (entry && entry.content) || {};
    var msg = '';
    if (c.messages && c.messages.length) {
        msg = c.messages
            .map(function (m) { return m && m.text ? m.text : ''; })
            .filter(Boolean)
            .join('; ');
    }
    // Splunk returns these as booleans over JSON, but older builds have sent
    // the strings "1"/"0", so coerce rather than trusting the type.
    return {
        done: c.isDone === true || c.isDone === '1',
        failed: c.isFailed === true || c.isFailed === '1',
        message: msg,
    };
}

/*
 * opts:
 *   fetchImpl(url, init) -> Promise<response>   required
 *   sleep(ms) -> Promise                        required
 *   headers                                     request headers object
 *   createUrl, createBody                       job creation
 *   jobUrlFor(sid), resultsUrlFor(sid)          status + results URLs
 *   signal                                      { aborted } checked between steps
 *   maxPolls                                    safety cap
 * Resolves to an array of result rows.
 */
function runJob(opts) {
    var fetchImpl = opts.fetchImpl;
    var sleep = opts.sleep;
    var signal = opts.signal;
    var maxPolls = opts.maxPolls || DEFAULT_MAX_POLLS;
    var maxTransient = opts.maxTransientRetries != null ? opts.maxTransientRetries : MAX_TRANSIENT_RETRIES;

    // NOTE: `signal` is deliberately NOT passed to any fetch below.
    //
    // exec_mode=normal means splunkd has already dispatched a real job by the
    // time the create POST responds. If the client aborted that request
    // mid-flight, the response (and with it the sid) is lost while the job keeps
    // running, and nothing can ever DELETE it. The wrapper aborts on every KO
    // re-selection, so clicking through rows would strand one search per click
    // against the user's srchJobsQuota until they aged out.
    //
    // Instead, every request is allowed to complete and the abort is honored
    // BETWEEN steps, where the sid is known and the job can be cleaned up. Each
    // individual request is short, so the cost is a brief delay before the
    // abort takes effect, in exchange for never leaking a running search.
    if (aborted(signal)) return Promise.reject(abortError());

    var sid = null;

    // Best-effort server-side cleanup. A job we stop caring about should not
    // keep consuming search resources, and a finished one should not leave a
    // dispatch directory sitting for its full TTL. Failures are never surfaced.
    function cancelJob() {
        if (!sid || !opts.jobUrlFor) return Promise.resolve();
        var del = { method: 'DELETE', credentials: 'same-origin', headers: opts.headers };
        try {
            return Promise.resolve(fetchImpl(opts.jobUrlFor(sid), del)).then(
                function () {}, function () {}
            );
        } catch (e) {
            return Promise.resolve();
        }
    }

    function failWith(err) {
        return cancelJob().then(function () { return Promise.reject(err); });
    }

    var GET = { method: 'GET', credentials: 'same-origin', headers: opts.headers };

    return Promise.resolve(fetchImpl(opts.createUrl, {
        method: 'POST', credentials: 'same-origin', headers: opts.headers, body: opts.createBody,
    }))
        .then(okJson)
        .then(function (j) {
            sid = j && j.sid;
            if (!sid) return Promise.reject(new Error('search job creation returned no sid'));
            // The job now exists server-side. From here every exit path runs
            // through failWith/cancelJob so it cannot be stranded.
            if (aborted(signal)) return failWith(abortError());

            var delay = POLL_START_MS;
            var polls = 0;
            var transient = 0;

            function poll() {
                if (aborted(signal)) return failWith(abortError());
                if (polls >= maxPolls) {
                    return failWith(new Error('search did not finish in time'));
                }
                polls++;
                return Promise.resolve(fetchImpl(opts.jobUrlFor(sid), GET))
                    .then(okJson)
                    .then(function (statusJson) {
                        var st = jobStatus(statusJson);
                        if (st.failed) {
                            return failWith(new Error(st.message || 'search failed'));
                        }
                        if (st.done) return null;
                        if (aborted(signal)) return failWith(abortError());
                        return sleep(delay).then(function () {
                            delay = nextDelay(delay);
                            return poll();
                        });
                    }, function (err) {
                        // A transport hiccup on ONE status poll says nothing
                        // about the search, which is very likely still running.
                        // Failing the whole fetch here would make the user
                        // re-run a search that was about to succeed.
                        if (err && err.retryable && transient < maxTransient) {
                            transient++;
                            return sleep(delay).then(function () {
                                delay = nextDelay(delay);
                                return poll();
                            });
                        }
                        return failWith(err);
                    });
            }

            return poll();
        })
        .then(function () {
            if (aborted(signal)) return failWith(abortError());
            return Promise.resolve(fetchImpl(opts.resultsUrlFor(sid), GET))
                .then(okJson, function (err) { return failWith(err); });
        })
        .then(function (j) {
            // okJson returns null for a 204/empty body (a job that matched
            // nothing), which becomes an empty row list exactly as the old
            // oneshot envelope did.
            var rows = j && j.results ? j.results : [];
            // Reap the finished job. exec_mode=oneshot was self-cleaning;
            // exec_mode=normal leaves a dispatch directory for its full TTL, so
            // without this a browsing session accumulates one per click.
            // Cleanup must never change what the caller sees, hence the
            // swallow-and-return.
            return cancelJob().then(function () { return rows; }, function () { return rows; });
        });
}

module.exports = { runJob: runJob, nextDelay: nextDelay, jobStatus: jobStatus };
