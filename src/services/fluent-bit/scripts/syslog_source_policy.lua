-- Enforce trusted source policy for ingress sources.
-- Trusted sources are read from /fluent-bit/etc/syslog-trusted-sources.txt

local TRUSTED_FILE = "/fluent-bit/etc/syslog-trusted-sources.txt"
local RELOAD_SEC = 30

local trusted = {}
local last_load = 0
local warned = false
local ENFORCED_TAGS = {
    ["ingest.syslog"] = true,
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

local function load_trusted_sources()
    local now = os.time()
    if (now - last_load) < RELOAD_SEC and next(trusted) ~= nil then
        return
    end

    local f = io.open(TRUSTED_FILE, "r")
    if not f then
        if not warned then
            warned = true
            print("[syslog_source_policy] trusted source file not found: " .. TRUSTED_FILE)
        end
        trusted = {}
        last_load = now
        return
    end

    local t = {}
    for line in f:lines() do
        local v = trim(line)
        if v ~= "" and string.sub(v, 1, 1) ~= "#" then
            t[normalize_sender(v)] = true
        end
    end
    f:close()

    trusted = t
    warned = false
    last_load = now
end

function enforce_syslog_source_policy(tag, timestamp, record)
    if not ENFORCED_TAGS[tag] then
        return 0, timestamp, record
    end

    load_trusted_sources()
    local sender = normalize_sender(record["syslog_sender_ip"])
    if sender == "" then
        sender = normalize_sender(record["source"])
    end
    local host = normalize_sender(record["host"])

    -- If trusted list is empty, fail-safe deny for syslog ingress.
    if next(trusted) == nil then
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
