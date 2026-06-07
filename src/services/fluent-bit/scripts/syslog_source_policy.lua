-- Enforce trusted source policy for ingress sources.
-- Trusted sources are read from /fluent-bit/etc/syslog-trusted-sources.txt
-- Enrolled agent ingress are read from /fluent-bit/etc/agent-trusted-sources.txt
--   (auto-managed by panel on /api/agent/activate; pre-authenticated by enrollment token).

local TRUSTED_FILE = "/fluent-bit/etc/syslog-trusted-sources.txt"
local AGENT_TRUSTED_FILE = "/fluent-bit/etc/agent-trusted-sources.txt"
local RELOAD_SEC = 30

local trusted = {}
local agent_trusted = {}
local last_load = 0
local last_agent_load = 0
local warned = false
local agent_warned = false
local ENFORCED_TAGS = {
    ["ingest.syslog"] = true,
    ["test.generator"] = true,
}
-- Tags from authenticated agent ingest: still source-filtered, but against the
-- agent-trusted-sources list maintained by the panel during /api/agent/activate.
local AGENT_TAGS = {
    ["test.generator"] = true,
}

local function trim(s)
    return (s:gsub("^%s+", ""):gsub("%s+$", ""))
end

local function normalize_sender(v)
    local s = trim(tostring(v or ""))
    if s == "" then
        return ""
    end
    -- Accept raw IP/FQDN, or transport format like udp://10.10.100.10:55123
    local host = s:match("^%a+://([^:/]+):?%d*$")
    if host and host ~= "" then
        return string.lower(host)
    end
    -- host:port fallback
    local hp = s:match("^([^:/]+):%d+$")
    if hp and hp ~= "" then
        return string.lower(hp)
    end
    return string.lower(s)
end

local function _load_list(path, prior, last, warned_flag, label)
    local now = os.time()
    if (now - last) < RELOAD_SEC and next(prior) ~= nil then
        return prior, last, warned_flag
    end
    local f = io.open(path, "r")
    if not f then
        if not warned_flag then
            print("[syslog_source_policy] " .. label .. " file not found: " .. path)
        end
        return {}, now, true
    end
    local t = {}
    for line in f:lines() do
        local v = trim(line)
        if v ~= "" and string.sub(v, 1, 1) ~= "#" then
            t[normalize_sender(v)] = true
        end
    end
    f:close()
    return t, now, false
end

local function load_trusted_sources()
    trusted, last_load, warned = _load_list(TRUSTED_FILE, trusted, last_load, warned, "trusted")
end

local function load_agent_sources()
    agent_trusted, last_agent_load, agent_warned = _load_list(
        AGENT_TRUSTED_FILE, agent_trusted, last_agent_load, agent_warned, "agent-trusted"
    )
end

local function _record_source_keys(record)
    local sender = normalize_sender(record["syslog_sender_ip"])
    if sender == "" then
        sender = normalize_sender(record["source"])
    end
    if sender == "" then
        sender = normalize_sender(record["agent_ip"])
    end
    local host = normalize_sender(record["host"])
    return sender, host
end

function enforce_syslog_source_policy(tag, timestamp, record)
    if not ENFORCED_TAGS[tag] then
        return 0, timestamp, record
    end

    -- Agent ingress (port 5151): enrolled agents matched against agent-trusted list.
    if AGENT_TAGS[tag] then
        load_agent_sources()
        -- Defensive: legacy agents (Fluent Bit Format=json) wrap a single batch
        -- as a JSON array; the receiver then sees one record with the inner
        -- objects nested under `msg`. Lift the first inner object's fields to
        -- the top level so downstream filters and Graylog extractors see
        -- host/source/EventID at the right place. New agents use json_lines and
        -- skip this branch entirely.
        if type(record["msg"]) == "table" and type(record["msg"][1]) == "table" and record["msg"][1].host then
            local inner = record["msg"][1]
            for k, v in pairs(inner) do
                if record[k] == nil then
                    record[k] = v
                end
            end
            record["_agent_batch_size"] = #record["msg"]
            record["msg"] = nil
        end
        local sender, host = _record_source_keys(record)
        if sender ~= "" and agent_trusted[sender] then
            record["source_policy"] = "agent_trusted"
            return 2, timestamp, record
        end
        if host ~= "" and agent_trusted[host] then
            record["source_policy"] = "agent_trusted"
            return 2, timestamp, record
        end
        -- Token-enrolled agents whose source IP is not yet in the trust list
        -- (e.g. first heartbeat lost, dual-NIC NAT, IP change) are still
        -- accepted but flagged so operators can investigate via Graylog.
        record["source_policy"] = "agent_untrusted_passthrough"
        return 2, timestamp, record
    end

    load_trusted_sources()
    local sender, host = _record_source_keys(record)

    -- If trusted list is empty AND no agent match, fail-safe deny for syslog ingress.
    if next(trusted) == nil and not AGENT_TAGS[tag] then
        return -1, timestamp, record
    end

    if sender ~= "" and trusted[sender] then
        record["source_policy"] = "trusted"
        return 2, timestamp, record
    end

    if host ~= "" and trusted[host] then
        record["source_policy"] = "trusted"
        return 2, timestamp, record
    end

    record["source_policy"] = "untrusted"
    return -1, timestamp, record
end
