// Generated from the gitleaks rule table.
// gitleaks: https://github.com/gitleaks/gitleaks, MIT License, Copyright (c) 2019 Zachary Rice.
// The licence text is in licenses/gitleaks-MIT.txt. Do not edit by hand.

export interface GeneratedRule {
  id: string;
  regex: string;
  flags: string;
  /** Which capture group holds the secret (0 = the whole match). */
  secretGroup: number;
  /** Minimum Shannon entropy of the secret (0 = no check). */
  entropy: number;
  /** At least one of these (lower case) must appear in the text before the rule is tried. */
  keywords: string[];
}

export const gitleaksRules: GeneratedRule[] = [
 {
  "id": "1password-secret-key",
  "regex": "\\bA3-[A-Z0-9]{6}-(?:(?:[A-Z0-9]{11})|(?:[A-Z0-9]{6}-[A-Z0-9]{5}))-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}\\b",
  "flags": "",
  "secretGroup": 0,
  "entropy": 3.8,
  "keywords": [
   "a3-"
  ]
 },
 {
  "id": "1password-service-account-token",
  "regex": "ops_eyJ[a-zA-Z0-9+/]{250,}={0,3}",
  "flags": "",
  "secretGroup": 0,
  "entropy": 4,
  "keywords": [
   "ops_"
  ]
 },
 {
  "id": "adafruit-api-key",
  "regex": "[\\w.-]{0,50}?(?:adafruit)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9_-]{32})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "adafruit"
  ]
 },
 {
  "id": "adobe-client-id",
  "regex": "[\\w.-]{0,50}?(?:adobe)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-f0-9]{32})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 2,
  "keywords": [
   "adobe"
  ]
 },
 {
  "id": "age-secret-key",
  "regex": "AGE-SECRET-KEY-1[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]{58}",
  "flags": "",
  "secretGroup": 0,
  "entropy": 0,
  "keywords": [
   "age-secret-key-1"
  ]
 },
 {
  "id": "airtable-api-key",
  "regex": "[\\w.-]{0,50}?(?:airtable)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9]{17})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "airtable"
  ]
 },
 {
  "id": "airtable-personnal-access-token",
  "regex": "\\b(pat[a-zA-Z0-9]{14}\\.[a-f0-9]{64})\\b",
  "flags": "",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "airtable"
  ]
 },
 {
  "id": "algolia-api-key",
  "regex": "[\\w.-]{0,50}?(?:algolia)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9]{32})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "algolia"
  ]
 },
 {
  "id": "alibaba-secret-key",
  "regex": "[\\w.-]{0,50}?(?:alibaba)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9]{30})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 2,
  "keywords": [
   "alibaba"
  ]
 },
 {
  "id": "anthropic-admin-api-key",
  "regex": "\\b(sk-ant-admin01-[a-zA-Z0-9_\\-]{93}AA)(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "sk-ant-admin01"
  ]
 },
 {
  "id": "anthropic-api-key",
  "regex": "\\b(sk-ant-api03-[a-zA-Z0-9_\\-]{93}AA)(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "sk-ant-api03"
  ]
 },
 {
  "id": "artifactory-api-key",
  "regex": "\\bAKCp[A-Za-z0-9]{69}\\b",
  "flags": "",
  "secretGroup": 0,
  "entropy": 4.5,
  "keywords": [
   "akcp"
  ]
 },
 {
  "id": "artifactory-reference-token",
  "regex": "\\bcmVmd[A-Za-z0-9]{59}\\b",
  "flags": "",
  "secretGroup": 0,
  "entropy": 4.5,
  "keywords": [
   "cmvmd"
  ]
 },
 {
  "id": "asana-client-id",
  "regex": "[\\w.-]{0,50}?(?:asana)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([0-9]{16})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "asana"
  ]
 },
 {
  "id": "asana-client-secret",
  "regex": "[\\w.-]{0,50}?(?:asana)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9]{32})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "asana"
  ]
 },
 {
  "id": "atlassian-api-token",
  "regex": "[\\w.-]{0,50}?(?:(?-i:ATLASSIAN|[Aa]tlassian)|(?-i:CONFLUENCE|[Cc]onfluence)|(?-i:JIRA|[Jj]ira))(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9]{20}[a-f0-9]{4})(?:[\\x60'\"\\s;]|\\\\[nr]|$)|\\b(ATATT3[A-Za-z0-9_\\-=]{186})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 3.5,
  "keywords": [
   "atlassian",
   "confluence",
   "jira",
   "atatt3"
  ]
 },
 {
  "id": "aws-access-token",
  "regex": "\\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})\\b",
  "flags": "",
  "secretGroup": 1,
  "entropy": 3,
  "keywords": [
   "a3t",
   "akia",
   "asia",
   "abia",
   "acca"
  ]
 },
 {
  "id": "aws-amazon-bedrock-api-key-long-lived",
  "regex": "\\b(ABSK[A-Za-z0-9+/]{109,269}={0,2})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "",
  "secretGroup": 1,
  "entropy": 3,
  "keywords": [
   "absk"
  ]
 },
 {
  "id": "aws-amazon-bedrock-api-key-short-lived",
  "regex": "bedrock-api-key-YmVkcm9jay5hbWF6b25hd3MuY29t",
  "flags": "",
  "secretGroup": 0,
  "entropy": 3,
  "keywords": [
   "bedrock-api-key-"
  ]
 },
 {
  "id": "azure-ad-client-secret",
  "regex": "(?:^|[\\\\'\"\\x60\\s>=:(,)])([a-zA-Z0-9_~.]{3}\\dQ~[a-zA-Z0-9_~.-]{31,34})(?:$|[\\\\'\"\\x60\\s<),])",
  "flags": "",
  "secretGroup": 1,
  "entropy": 3,
  "keywords": [
   "q~"
  ]
 },
 {
  "id": "beamer-api-token",
  "regex": "[\\w.-]{0,50}?(?:beamer)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}(b_[a-z0-9=_\\-]{44})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "beamer"
  ]
 },
 {
  "id": "bitbucket-client-id",
  "regex": "[\\w.-]{0,50}?(?:bitbucket)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9]{32})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "bitbucket"
  ]
 },
 {
  "id": "bitbucket-client-secret",
  "regex": "[\\w.-]{0,50}?(?:bitbucket)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9=_\\-]{64})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "bitbucket"
  ]
 },
 {
  "id": "bittrex-access-key",
  "regex": "[\\w.-]{0,50}?(?:bittrex)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9]{32})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "bittrex"
  ]
 },
 {
  "id": "bittrex-secret-key",
  "regex": "[\\w.-]{0,50}?(?:bittrex)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9]{32})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "bittrex"
  ]
 },
 {
  "id": "cisco-meraki-api-key",
  "regex": "[\\w.-]{0,50}?(?i:[\\w.-]{0,50}?(?:(?-i:[Mm]eraki|MERAKI))(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3})(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([0-9a-f]{40})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "",
  "secretGroup": 1,
  "entropy": 3,
  "keywords": [
   "meraki"
  ]
 },
 {
  "id": "clickhouse-cloud-api-secret-key",
  "regex": "\\b(4b1d[A-Za-z0-9]{38})\\b",
  "flags": "",
  "secretGroup": 1,
  "entropy": 3,
  "keywords": [
   "4b1d"
  ]
 },
 {
  "id": "clojars-api-token",
  "regex": "CLOJARS_[a-z0-9]{60}",
  "flags": "i",
  "secretGroup": 0,
  "entropy": 2,
  "keywords": [
   "clojars_"
  ]
 },
 {
  "id": "cloudflare-api-key",
  "regex": "[\\w.-]{0,50}?(?:cloudflare)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9_-]{40})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 2,
  "keywords": [
   "cloudflare"
  ]
 },
 {
  "id": "cloudflare-global-api-key",
  "regex": "[\\w.-]{0,50}?(?:cloudflare)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-f0-9]{37})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 2,
  "keywords": [
   "cloudflare"
  ]
 },
 {
  "id": "cloudflare-origin-ca-key",
  "regex": "\\b(v1\\.0-[a-f0-9]{24}-[a-f0-9]{146})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "",
  "secretGroup": 1,
  "entropy": 2,
  "keywords": [
   "cloudflare",
   "v1.0-"
  ]
 },
 {
  "id": "codecov-access-token",
  "regex": "[\\w.-]{0,50}?(?:codecov)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9]{32})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "codecov"
  ]
 },
 {
  "id": "cohere-api-token",
  "regex": "[\\w.-]{0,50}?(?i:[\\w.-]{0,50}?(?:cohere|CO_API_KEY)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3})(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-zA-Z0-9]{40})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "",
  "secretGroup": 1,
  "entropy": 4,
  "keywords": [
   "cohere",
   "co_api_key"
  ]
 },
 {
  "id": "coinbase-access-token",
  "regex": "[\\w.-]{0,50}?(?:coinbase)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9_-]{64})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "coinbase"
  ]
 },
 {
  "id": "confluent-access-token",
  "regex": "[\\w.-]{0,50}?(?:confluent)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9]{16})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "confluent"
  ]
 },
 {
  "id": "confluent-secret-key",
  "regex": "[\\w.-]{0,50}?(?:confluent)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9]{64})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "confluent"
  ]
 },
 {
  "id": "contentful-delivery-api-token",
  "regex": "[\\w.-]{0,50}?(?:contentful)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9=_\\-]{43})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "contentful"
  ]
 },
 {
  "id": "curl-auth-user",
  "regex": "\\bcurl\\b(?:.*|.*(?:[\\r\\n]{1,2}.*){1,5})[ \\t\\n\\r](?:-u|--user)(?:=|[ \\t]{0,5})(\"(:[^\"]{3,}|[^:\"]{3,}:|[^:\"]{3,}:[^\"]{3,})\"|'([^:']{3,}:[^']{3,})'|((?:\"[^\"]{3,}\"|'[^']{3,}'|[\\w$@.-]+):(?:\"[^\"]{3,}\"|'[^']{3,}'|[\\w${}@.-]+)))(?:\\s|$)",
  "flags": "",
  "secretGroup": 1,
  "entropy": 2,
  "keywords": [
   "curl"
  ]
 },
 {
  "id": "databricks-api-token",
  "regex": "\\b(dapi[a-f0-9]{32}(?:-\\d)?)(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "",
  "secretGroup": 1,
  "entropy": 3,
  "keywords": [
   "dapi"
  ]
 },
 {
  "id": "datadog-access-token",
  "regex": "[\\w.-]{0,50}?(?:datadog)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9]{40})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "datadog"
  ]
 },
 {
  "id": "defined-networking-api-token",
  "regex": "[\\w.-]{0,50}?(?:dnkey)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}(dnkey-[a-z0-9=_\\-]{26}-[a-z0-9=_\\-]{52})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "dnkey"
  ]
 },
 {
  "id": "digitalocean-access-token",
  "regex": "\\b(doo_v1_[a-f0-9]{64})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "",
  "secretGroup": 1,
  "entropy": 3,
  "keywords": [
   "doo_v1_"
  ]
 },
 {
  "id": "digitalocean-pat",
  "regex": "\\b(dop_v1_[a-f0-9]{64})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "",
  "secretGroup": 1,
  "entropy": 3,
  "keywords": [
   "dop_v1_"
  ]
 },
 {
  "id": "digitalocean-refresh-token",
  "regex": "\\b(dor_v1_[a-f0-9]{64})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "dor_v1_"
  ]
 },
 {
  "id": "discord-api-token",
  "regex": "[\\w.-]{0,50}?(?:discord)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-f0-9]{64})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "discord"
  ]
 },
 {
  "id": "discord-client-id",
  "regex": "[\\w.-]{0,50}?(?:discord)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([0-9]{18})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 2,
  "keywords": [
   "discord"
  ]
 },
 {
  "id": "discord-client-secret",
  "regex": "[\\w.-]{0,50}?(?:discord)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9=_\\-]{32})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 2,
  "keywords": [
   "discord"
  ]
 },
 {
  "id": "droneci-access-token",
  "regex": "[\\w.-]{0,50}?(?:droneci)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9]{32})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "droneci"
  ]
 },
 {
  "id": "dropbox-api-token",
  "regex": "[\\w.-]{0,50}?(?:dropbox)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9]{15})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "dropbox"
  ]
 },
 {
  "id": "dropbox-long-lived-api-token",
  "regex": "[\\w.-]{0,50}?(?:dropbox)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9]{11}(AAAAAAAAAA)[a-z0-9\\-_=]{43})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "dropbox"
  ]
 },
 {
  "id": "dropbox-short-lived-api-token",
  "regex": "[\\w.-]{0,50}?(?:dropbox)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}(sl\\.[a-z0-9\\-=_]{135})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "dropbox"
  ]
 },
 {
  "id": "etsy-access-token",
  "regex": "[\\w.-]{0,50}?(?:(?-i:ETSY|[Ee]tsy))(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9]{24})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 3,
  "keywords": [
   "etsy"
  ]
 },
 {
  "id": "facebook-access-token",
  "regex": "\\b(\\d{15,16}(\\||%)[0-9a-z\\-_]{27,40})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 3,
  "keywords": [
   "facebook"
  ]
 },
 {
  "id": "facebook-secret",
  "regex": "[\\w.-]{0,50}?(?:facebook)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-f0-9]{32})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 3,
  "keywords": [
   "facebook"
  ]
 },
 {
  "id": "fastly-api-token",
  "regex": "[\\w.-]{0,50}?(?:fastly)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9=_\\-]{32})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "fastly"
  ]
 },
 {
  "id": "finicity-api-token",
  "regex": "[\\w.-]{0,50}?(?:finicity)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-f0-9]{32})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "finicity"
  ]
 },
 {
  "id": "finicity-client-secret",
  "regex": "[\\w.-]{0,50}?(?:finicity)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9]{20})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "finicity"
  ]
 },
 {
  "id": "finnhub-access-token",
  "regex": "[\\w.-]{0,50}?(?:finnhub)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9]{20})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "finnhub"
  ]
 },
 {
  "id": "flickr-access-token",
  "regex": "[\\w.-]{0,50}?(?:flickr)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9]{32})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "flickr"
  ]
 },
 {
  "id": "flyio-access-token",
  "regex": "\\b((?:fo1_[\\w-]{43}|fm1[ar]_[a-zA-Z0-9+\\/]{100,}={0,3}|fm2_[a-zA-Z0-9+\\/]{100,}={0,3}))(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "",
  "secretGroup": 1,
  "entropy": 4,
  "keywords": [
   "fo1_",
   "fm1",
   "fm2_"
  ]
 },
 {
  "id": "freemius-secret-key",
  "regex": "[\"']secret_key[\"']\\s*=>\\s*[\"'](sk_[\\S]{29})[\"']",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "secret_key"
  ]
 },
 {
  "id": "freshbooks-access-token",
  "regex": "[\\w.-]{0,50}?(?:freshbooks)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9]{64})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "freshbooks"
  ]
 },
 {
  "id": "gcp-api-key",
  "regex": "\\b(AIza[\\w-]{35})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "",
  "secretGroup": 1,
  "entropy": 4,
  "keywords": [
   "aiza"
  ]
 },
 {
  "id": "generic-api-key",
  "regex": "[\\w.-]{0,50}?(?:access|auth|(?-i:[Aa]pi|API)|credential|creds|key|passw(?:or)?d|secret|token)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([\\w.=-]{10,150}|[a-z0-9][a-z0-9+/]{11,}={0,3})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 3.5,
  "keywords": [
   "access",
   "api",
   "auth",
   "key",
   "credential",
   "creds",
   "passwd",
   "password",
   "secret",
   "token"
  ]
 },
 {
  "id": "github-app-token",
  "regex": "(?:ghu|ghs)_[0-9a-zA-Z]{36}",
  "flags": "",
  "secretGroup": 0,
  "entropy": 3,
  "keywords": [
   "ghu_",
   "ghs_"
  ]
 },
 {
  "id": "github-fine-grained-pat",
  "regex": "github_pat_\\w{82}",
  "flags": "",
  "secretGroup": 0,
  "entropy": 3,
  "keywords": [
   "github_pat_"
  ]
 },
 {
  "id": "github-oauth",
  "regex": "gho_[0-9a-zA-Z]{36}",
  "flags": "",
  "secretGroup": 0,
  "entropy": 3,
  "keywords": [
   "gho_"
  ]
 },
 {
  "id": "github-pat",
  "regex": "ghp_[0-9a-zA-Z]{36}",
  "flags": "",
  "secretGroup": 0,
  "entropy": 3,
  "keywords": [
   "ghp_"
  ]
 },
 {
  "id": "github-refresh-token",
  "regex": "ghr_[0-9a-zA-Z]{36}",
  "flags": "",
  "secretGroup": 0,
  "entropy": 3,
  "keywords": [
   "ghr_"
  ]
 },
 {
  "id": "gitlab-cicd-job-token",
  "regex": "glcbt-[0-9a-zA-Z]{1,5}_[0-9a-zA-Z_-]{20}",
  "flags": "",
  "secretGroup": 0,
  "entropy": 3,
  "keywords": [
   "glcbt-"
  ]
 },
 {
  "id": "gitlab-deploy-token",
  "regex": "gldt-[0-9a-zA-Z_\\-]{20}",
  "flags": "",
  "secretGroup": 0,
  "entropy": 3,
  "keywords": [
   "gldt-"
  ]
 },
 {
  "id": "gitlab-feature-flag-client-token",
  "regex": "glffct-[0-9a-zA-Z_\\-]{20}",
  "flags": "",
  "secretGroup": 0,
  "entropy": 3,
  "keywords": [
   "glffct-"
  ]
 },
 {
  "id": "gitlab-feed-token",
  "regex": "glft-[0-9a-zA-Z_\\-]{20}",
  "flags": "",
  "secretGroup": 0,
  "entropy": 3,
  "keywords": [
   "glft-"
  ]
 },
 {
  "id": "gitlab-incoming-mail-token",
  "regex": "glimt-[0-9a-zA-Z_\\-]{25}",
  "flags": "",
  "secretGroup": 0,
  "entropy": 3,
  "keywords": [
   "glimt-"
  ]
 },
 {
  "id": "gitlab-kubernetes-agent-token",
  "regex": "glagent-[0-9a-zA-Z_\\-]{50}",
  "flags": "",
  "secretGroup": 0,
  "entropy": 3,
  "keywords": [
   "glagent-"
  ]
 },
 {
  "id": "gitlab-oauth-app-secret",
  "regex": "gloas-[0-9a-zA-Z_\\-]{64}",
  "flags": "",
  "secretGroup": 0,
  "entropy": 3,
  "keywords": [
   "gloas-"
  ]
 },
 {
  "id": "gitlab-pat",
  "regex": "glpat-[\\w-]{20}",
  "flags": "",
  "secretGroup": 0,
  "entropy": 3,
  "keywords": [
   "glpat-"
  ]
 },
 {
  "id": "gitlab-pat-routable",
  "regex": "\\bglpat-[0-9a-zA-Z_-]{27,300}\\.[0-9a-z]{2}[0-9a-z]{7}\\b",
  "flags": "",
  "secretGroup": 0,
  "entropy": 4,
  "keywords": [
   "glpat-"
  ]
 },
 {
  "id": "gitlab-ptt",
  "regex": "glptt-[0-9a-f]{40}",
  "flags": "",
  "secretGroup": 0,
  "entropy": 3,
  "keywords": [
   "glptt-"
  ]
 },
 {
  "id": "gitlab-rrt",
  "regex": "GR1348941[\\w-]{20}",
  "flags": "",
  "secretGroup": 0,
  "entropy": 3,
  "keywords": [
   "gr1348941"
  ]
 },
 {
  "id": "gitlab-runner-authentication-token",
  "regex": "glrt-[0-9a-zA-Z_\\-]{20}",
  "flags": "",
  "secretGroup": 0,
  "entropy": 3,
  "keywords": [
   "glrt-"
  ]
 },
 {
  "id": "gitlab-runner-authentication-token-routable",
  "regex": "\\bglrt-t\\d_[0-9a-zA-Z_\\-]{27,300}\\.[0-9a-z]{2}[0-9a-z]{7}\\b",
  "flags": "",
  "secretGroup": 0,
  "entropy": 4,
  "keywords": [
   "glrt-"
  ]
 },
 {
  "id": "gitlab-scim-token",
  "regex": "glsoat-[0-9a-zA-Z_\\-]{20}",
  "flags": "",
  "secretGroup": 0,
  "entropy": 3,
  "keywords": [
   "glsoat-"
  ]
 },
 {
  "id": "gitlab-session-cookie",
  "regex": "_gitlab_session=[0-9a-z]{32}",
  "flags": "",
  "secretGroup": 0,
  "entropy": 3,
  "keywords": [
   "_gitlab_session="
  ]
 },
 {
  "id": "gitter-access-token",
  "regex": "[\\w.-]{0,50}?(?:gitter)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9_-]{40})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "gitter"
  ]
 },
 {
  "id": "grafana-api-key",
  "regex": "\\b(eyJrIjoi[A-Za-z0-9]{70,400}={0,3})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 3,
  "keywords": [
   "eyjrijoi"
  ]
 },
 {
  "id": "grafana-cloud-api-token",
  "regex": "\\b(glc_[A-Za-z0-9+/]{32,400}={0,3})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 3,
  "keywords": [
   "glc_"
  ]
 },
 {
  "id": "grafana-service-account-token",
  "regex": "\\b(glsa_[A-Za-z0-9]{32}_[A-Fa-f0-9]{8})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 3,
  "keywords": [
   "glsa_"
  ]
 },
 {
  "id": "harness-api-key",
  "regex": "(?:pat|sat)\\.[a-zA-Z0-9_-]{22}\\.[a-zA-Z0-9]{24}\\.[a-zA-Z0-9]{20}",
  "flags": "",
  "secretGroup": 0,
  "entropy": 0,
  "keywords": [
   "pat.",
   "sat."
  ]
 },
 {
  "id": "hashicorp-tf-api-token",
  "regex": "[a-z0-9]{14}\\.(?-i:atlasv1)\\.[a-z0-9\\-_=]{60,70}",
  "flags": "i",
  "secretGroup": 0,
  "entropy": 3.5,
  "keywords": [
   "atlasv1"
  ]
 },
 {
  "id": "hashicorp-tf-password",
  "regex": "[\\w.-]{0,50}?(?:administrator_login_password|password)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}(\"[a-z0-9=_\\-]{8,20}\")(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 2,
  "keywords": [
   "administrator_login_password",
   "password"
  ]
 },
 {
  "id": "heroku-api-key",
  "regex": "[\\w.-]{0,50}?(?:heroku)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "heroku"
  ]
 },
 {
  "id": "heroku-api-key-v2",
  "regex": "\\b((HRKU-AA[0-9a-zA-Z_-]{58}))(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "",
  "secretGroup": 1,
  "entropy": 4,
  "keywords": [
   "hrku-aa"
  ]
 },
 {
  "id": "hubspot-api-key",
  "regex": "[\\w.-]{0,50}?(?:hubspot)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "hubspot"
  ]
 },
 {
  "id": "huggingface-access-token",
  "regex": "\\b(hf_(?i:[a-z]{34}))(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "",
  "secretGroup": 1,
  "entropy": 2,
  "keywords": [
   "hf_"
  ]
 },
 {
  "id": "huggingface-organization-api-token",
  "regex": "\\b(api_org_(?i:[a-z]{34}))(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "",
  "secretGroup": 1,
  "entropy": 2,
  "keywords": [
   "api_org_"
  ]
 },
 {
  "id": "infracost-api-token",
  "regex": "\\b(ico-[a-zA-Z0-9]{32})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "",
  "secretGroup": 1,
  "entropy": 3,
  "keywords": [
   "ico-"
  ]
 },
 {
  "id": "intercom-api-key",
  "regex": "[\\w.-]{0,50}?(?:intercom)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9=_\\-]{60})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "intercom"
  ]
 },
 {
  "id": "jfrog-api-key",
  "regex": "[\\w.-]{0,50}?(?:jfrog|artifactory|bintray|xray)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9]{73})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "jfrog",
   "artifactory",
   "bintray",
   "xray"
  ]
 },
 {
  "id": "jfrog-identity-token",
  "regex": "[\\w.-]{0,50}?(?:jfrog|artifactory|bintray|xray)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9]{64})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "jfrog",
   "artifactory",
   "bintray",
   "xray"
  ]
 },
 {
  "id": "jwt",
  "regex": "\\b(ey[a-zA-Z0-9]{17,}\\.ey[a-zA-Z0-9\\/\\\\_-]{17,}\\.(?:[a-zA-Z0-9\\/\\\\_-]{10,}={0,2})?)(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "",
  "secretGroup": 1,
  "entropy": 3,
  "keywords": [
   "ey"
  ]
 },
 {
  "id": "jwt-base64",
  "regex": "\\bZXlK(?:(?<alg>aGJHY2lPaU)|(?<apu>aGNIVWlPaU)|(?<apv>aGNIWWlPaU)|(?<aud>aGRXUWlPaU)|(?<b64>aU5qUWlP)|(?<crit>amNtbDBJanBi)|(?<cty>amRIa2lPaU)|(?<epk>bGNHc2lPbn)|(?<enc>bGJtTWlPaU)|(?<jku>cWEzVWlPaU)|(?<jwk>cWQyc2lPb)|(?<iss>cGMzTWlPaU)|(?<iv>cGRpSTZJ)|(?<kid>cmFXUWlP)|(?<key_ops>clpYbGZiM0J6SWpwY)|(?<kty>cmRIa2lPaUp)|(?<nonce>dWIyNWpaU0k2)|(?<p2c>d01tTWlP)|(?<p2s>d01uTWlPaU)|(?<ppt>d2NIUWlPaU)|(?<sub>emRXSWlPaU)|(?<svt>emRuUWlP)|(?<tag>MFlXY2lPaU)|(?<typ>MGVYQWlPaUp)|(?<url>MWNtd2l)|(?<use>MWMyVWlPaUp)|(?<ver>MlpYSWlPaU)|(?<version>MlpYSnphVzl1SWpv)|(?<x>NElqb2)|(?<x5c>NE5XTWlP)|(?<x5t>NE5YUWlPaU)|(?<x5ts256>NE5YUWpVekkxTmlJNkl)|(?<x5u>NE5YVWlPaU)|(?<zip>NmFYQWlPaU))[a-zA-Z0-9\\/\\\\_+\\-\\r\\n]{40,}={0,2}",
  "flags": "",
  "secretGroup": 1,
  "entropy": 2,
  "keywords": [
   "zxlk"
  ]
 },
 {
  "id": "kraken-access-token",
  "regex": "[\\w.-]{0,50}?(?:kraken)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9\\/=_\\+\\-]{80,90})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "kraken"
  ]
 },
 {
  "id": "kubernetes-secret-yaml",
  "regex": "(?:\\bkind:[ \\t]*[\"']?\\bsecret\\b[\"']?(?s:.){0,200}?\\bdata:(?s:.){0,100}?\\s+([\\w.-]+:(?:[ \\t]*(?:\\||>[-+]?)\\s+)?[ \\t]*(?:[\"']?[a-z0-9+/]{10,}={0,3}[\"']?|\\{\\{[ \\t\\w\"|$:=,.-]+}}|\"\"|''))|\\bdata:(?s:.){0,100}?\\s+([\\w.-]+:(?:[ \\t]*(?:\\||>[-+]?)\\s+)?[ \\t]*(?:[\"']?[a-z0-9+/]{10,}={0,3}[\"']?|\\{\\{[ \\t\\w\"|$:=,.-]+}}|\"\"|''))(?s:.){0,200}?\\bkind:[ \\t]*[\"']?\\bsecret\\b[\"']?)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "secret"
  ]
 },
 {
  "id": "kucoin-access-token",
  "regex": "[\\w.-]{0,50}?(?:kucoin)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-f0-9]{24})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "kucoin"
  ]
 },
 {
  "id": "kucoin-secret-key",
  "regex": "[\\w.-]{0,50}?(?:kucoin)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "kucoin"
  ]
 },
 {
  "id": "launchdarkly-access-token",
  "regex": "[\\w.-]{0,50}?(?:launchdarkly)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9=_\\-]{40})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "launchdarkly"
  ]
 },
 {
  "id": "linear-client-secret",
  "regex": "[\\w.-]{0,50}?(?:linear)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-f0-9]{32})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 2,
  "keywords": [
   "linear"
  ]
 },
 {
  "id": "linkedin-client-id",
  "regex": "[\\w.-]{0,50}?(?:linked[_-]?in)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9]{14})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 2,
  "keywords": [
   "linkedin",
   "linked_in",
   "linked-in"
  ]
 },
 {
  "id": "linkedin-client-secret",
  "regex": "[\\w.-]{0,50}?(?:linked[_-]?in)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9]{16})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 2,
  "keywords": [
   "linkedin",
   "linked_in",
   "linked-in"
  ]
 },
 {
  "id": "lob-api-key",
  "regex": "[\\w.-]{0,50}?(?:lob)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}((live|test)_[a-f0-9]{35})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "test_",
   "live_"
  ]
 },
 {
  "id": "lob-pub-api-key",
  "regex": "[\\w.-]{0,50}?(?:lob)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}((test|live)_pub_[a-f0-9]{31})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "test_pub",
   "live_pub",
   "_pub"
  ]
 },
 {
  "id": "looker-client-id",
  "regex": "[\\w.-]{0,50}?(?:looker)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9]{20})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "looker"
  ]
 },
 {
  "id": "looker-client-secret",
  "regex": "[\\w.-]{0,50}?(?:looker)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9]{24})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "looker"
  ]
 },
 {
  "id": "mailchimp-api-key",
  "regex": "[\\w.-]{0,50}?(?:MailchimpSDK.initialize|mailchimp)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-f0-9]{32}-us\\d\\d)(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "mailchimp"
  ]
 },
 {
  "id": "mailgun-private-api-token",
  "regex": "[\\w.-]{0,50}?(?:mailgun)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}(key-[a-f0-9]{32})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "mailgun"
  ]
 },
 {
  "id": "mailgun-pub-key",
  "regex": "[\\w.-]{0,50}?(?:mailgun)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}(pubkey-[a-f0-9]{32})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "mailgun"
  ]
 },
 {
  "id": "mailgun-signing-key",
  "regex": "[\\w.-]{0,50}?(?:mailgun)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-h0-9]{32}-[a-h0-9]{8}-[a-h0-9]{8})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "mailgun"
  ]
 },
 {
  "id": "mapbox-api-token",
  "regex": "[\\w.-]{0,50}?(?:mapbox)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}(pk\\.[a-z0-9]{60}\\.[a-z0-9]{22})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "mapbox"
  ]
 },
 {
  "id": "mattermost-access-token",
  "regex": "[\\w.-]{0,50}?(?:mattermost)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9]{26})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "mattermost"
  ]
 },
 {
  "id": "maxmind-license-key",
  "regex": "\\b([A-Za-z0-9]{6}_[A-Za-z0-9]{29}_mmk)(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "",
  "secretGroup": 1,
  "entropy": 4,
  "keywords": [
   "_mmk"
  ]
 },
 {
  "id": "messagebird-api-token",
  "regex": "[\\w.-]{0,50}?(?:message[_-]?bird)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9]{25})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "messagebird",
   "message-bird",
   "message_bird"
  ]
 },
 {
  "id": "messagebird-client-id",
  "regex": "[\\w.-]{0,50}?(?:message[_-]?bird)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "messagebird",
   "message-bird",
   "message_bird"
  ]
 },
 {
  "id": "microsoft-teams-webhook",
  "regex": "https://[a-z0-9]+\\.webhook\\.office\\.com/webhookb2/[a-z0-9]{8}-([a-z0-9]{4}-){3}[a-z0-9]{12}@[a-z0-9]{8}-([a-z0-9]{4}-){3}[a-z0-9]{12}/IncomingWebhook/[a-z0-9]{32}/[a-z0-9]{8}-([a-z0-9]{4}-){3}[a-z0-9]{12}",
  "flags": "",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "webhook.office.com",
   "webhookb2",
   "incomingwebhook"
  ]
 },
 {
  "id": "netlify-access-token",
  "regex": "[\\w.-]{0,50}?(?:netlify)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9=_\\-]{40,46})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "netlify"
  ]
 },
 {
  "id": "new-relic-browser-api-token",
  "regex": "[\\w.-]{0,50}?(?:new-relic|newrelic|new_relic)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}(NRJS-[a-f0-9]{19})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "nrjs-"
  ]
 },
 {
  "id": "new-relic-insert-key",
  "regex": "[\\w.-]{0,50}?(?:new-relic|newrelic|new_relic)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}(NRII-[a-z0-9-]{32})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "nrii-"
  ]
 },
 {
  "id": "new-relic-user-api-id",
  "regex": "[\\w.-]{0,50}?(?:new-relic|newrelic|new_relic)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9]{64})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "new-relic",
   "newrelic",
   "new_relic"
  ]
 },
 {
  "id": "new-relic-user-api-key",
  "regex": "[\\w.-]{0,50}?(?:new-relic|newrelic|new_relic)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}(NRAK-[a-z0-9]{27})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "nrak"
  ]
 },
 {
  "id": "notion-api-token",
  "regex": "\\b(ntn_[0-9]{11}[A-Za-z0-9]{32}[A-Za-z0-9]{3})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "",
  "secretGroup": 1,
  "entropy": 4,
  "keywords": [
   "ntn_"
  ]
 },
 {
  "id": "npm-access-token",
  "regex": "\\b(npm_[a-z0-9]{36})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 2,
  "keywords": [
   "npm_"
  ]
 },
 {
  "id": "nuget-config-password",
  "regex": "<add key=\\\"(?:(?:ClearText)?Password)\\\"\\s*value=\\\"(.{8,})\\\"\\s*/>",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 1,
  "keywords": [
   "<add key="
  ]
 },
 {
  "id": "nytimes-access-token",
  "regex": "[\\w.-]{0,50}?(?:nytimes|new-york-times,|newyorktimes)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9=_\\-]{32})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "nytimes",
   "new-york-times",
   "newyorktimes"
  ]
 },
 {
  "id": "octopus-deploy-api-key",
  "regex": "\\b(API-[A-Z0-9]{26})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "",
  "secretGroup": 1,
  "entropy": 3,
  "keywords": [
   "api-"
  ]
 },
 {
  "id": "okta-access-token",
  "regex": "[\\w.-]{0,50}?(?i:[\\w.-]{0,50}?(?:(?-i:[Oo]kta|OKTA))(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3})(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}(00[\\w=\\-]{40})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "",
  "secretGroup": 1,
  "entropy": 4,
  "keywords": [
   "okta"
  ]
 },
 {
  "id": "openai-api-key",
  "regex": "\\b(sk-(?:proj|svcacct|admin)-(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})T3BlbkFJ(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})\\b|sk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "",
  "secretGroup": 1,
  "entropy": 3,
  "keywords": [
   "t3blbkfj"
  ]
 },
 {
  "id": "openshift-user-token",
  "regex": "\\b(sha256~[\\w-]{43})(?:[^\\w-]|$)",
  "flags": "",
  "secretGroup": 1,
  "entropy": 3.5,
  "keywords": [
   "sha256~"
  ]
 },
 {
  "id": "perplexity-api-key",
  "regex": "\\b(pplx-[a-zA-Z0-9]{48})(?:[\\x60'\"\\s;]|\\\\[nr]|$|\\b)",
  "flags": "",
  "secretGroup": 1,
  "entropy": 4,
  "keywords": [
   "pplx-"
  ]
 },
 {
  "id": "plaid-api-token",
  "regex": "[\\w.-]{0,50}?(?:plaid)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}(access-(?:sandbox|development|production)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "plaid"
  ]
 },
 {
  "id": "plaid-client-id",
  "regex": "[\\w.-]{0,50}?(?:plaid)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9]{24})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 3.5,
  "keywords": [
   "plaid"
  ]
 },
 {
  "id": "plaid-secret-key",
  "regex": "[\\w.-]{0,50}?(?:plaid)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9]{30})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 3.5,
  "keywords": [
   "plaid"
  ]
 },
 {
  "id": "planetscale-oauth-token",
  "regex": "\\b(pscale_oauth_[\\w=\\.-]{32,64})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "",
  "secretGroup": 1,
  "entropy": 3,
  "keywords": [
   "pscale_oauth_"
  ]
 },
 {
  "id": "prefect-api-token",
  "regex": "\\b(pnu_[a-zA-Z0-9]{36})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "",
  "secretGroup": 1,
  "entropy": 2,
  "keywords": [
   "pnu_"
  ]
 },
 {
  "id": "private-key",
  "regex": "-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\\s\\S-]{64,}?KEY(?: BLOCK)?-----",
  "flags": "i",
  "secretGroup": 0,
  "entropy": 0,
  "keywords": [
   "-----begin"
  ]
 },
 {
  "id": "privateai-api-token",
  "regex": "[\\w.-]{0,50}?(?i:[\\w.-]{0,50}?(?:private[_-]?ai)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3})(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9]{32})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "",
  "secretGroup": 1,
  "entropy": 3,
  "keywords": [
   "privateai",
   "private_ai",
   "private-ai"
  ]
 },
 {
  "id": "pulumi-api-token",
  "regex": "\\b(pul-[a-f0-9]{40})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "",
  "secretGroup": 1,
  "entropy": 2,
  "keywords": [
   "pul-"
  ]
 },
 {
  "id": "pypi-upload-token",
  "regex": "pypi-AgEIcHlwaS5vcmc[\\w-]{50,1000}",
  "flags": "",
  "secretGroup": 0,
  "entropy": 3,
  "keywords": [
   "pypi-ageichlwas5vcmc"
  ]
 },
 {
  "id": "rapidapi-access-token",
  "regex": "[\\w.-]{0,50}?(?:rapidapi)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9_-]{50})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "rapidapi"
  ]
 },
 {
  "id": "readme-api-token",
  "regex": "\\b(rdme_[a-z0-9]{70})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "",
  "secretGroup": 1,
  "entropy": 2,
  "keywords": [
   "rdme_"
  ]
 },
 {
  "id": "rubygems-api-token",
  "regex": "\\b(rubygems_[a-f0-9]{48})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "",
  "secretGroup": 1,
  "entropy": 2,
  "keywords": [
   "rubygems_"
  ]
 },
 {
  "id": "scalingo-api-token",
  "regex": "\\b(tk-us-[\\w-]{48})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "",
  "secretGroup": 1,
  "entropy": 2,
  "keywords": [
   "tk-us-"
  ]
 },
 {
  "id": "sendbird-access-id",
  "regex": "[\\w.-]{0,50}?(?:sendbird)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "sendbird"
  ]
 },
 {
  "id": "sendbird-access-token",
  "regex": "[\\w.-]{0,50}?(?:sendbird)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-f0-9]{40})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "sendbird"
  ]
 },
 {
  "id": "sentry-access-token",
  "regex": "[\\w.-]{0,50}?(?:sentry)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-f0-9]{64})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 3,
  "keywords": [
   "sentry"
  ]
 },
 {
  "id": "sentry-org-token",
  "regex": "\\bsntrys_eyJpYXQiO[a-zA-Z0-9+/]{10,200}(?:LCJyZWdpb25fdXJs|InJlZ2lvbl91cmwi|cmVnaW9uX3VybCI6)[a-zA-Z0-9+/]{10,200}={0,2}_[a-zA-Z0-9+/]{43}(?:[^a-zA-Z0-9+/]|$)",
  "flags": "",
  "secretGroup": 0,
  "entropy": 4.5,
  "keywords": [
   "sntrys_eyjpyxqio"
  ]
 },
 {
  "id": "sentry-user-token",
  "regex": "\\b(sntryu_[a-f0-9]{64})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "",
  "secretGroup": 1,
  "entropy": 3.5,
  "keywords": [
   "sntryu_"
  ]
 },
 {
  "id": "settlemint-application-access-token",
  "regex": "\\b(sm_aat_[a-zA-Z0-9]{16})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "",
  "secretGroup": 1,
  "entropy": 3,
  "keywords": [
   "sm_aat"
  ]
 },
 {
  "id": "settlemint-personal-access-token",
  "regex": "\\b(sm_pat_[a-zA-Z0-9]{16})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "",
  "secretGroup": 1,
  "entropy": 3,
  "keywords": [
   "sm_pat"
  ]
 },
 {
  "id": "settlemint-service-access-token",
  "regex": "\\b(sm_sat_[a-zA-Z0-9]{16})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "",
  "secretGroup": 1,
  "entropy": 3,
  "keywords": [
   "sm_sat"
  ]
 },
 {
  "id": "shippo-api-token",
  "regex": "\\b(shippo_(?:live|test)_[a-fA-F0-9]{40})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "",
  "secretGroup": 1,
  "entropy": 2,
  "keywords": [
   "shippo_"
  ]
 },
 {
  "id": "shopify-access-token",
  "regex": "shpat_[a-fA-F0-9]{32}",
  "flags": "",
  "secretGroup": 0,
  "entropy": 2,
  "keywords": [
   "shpat_"
  ]
 },
 {
  "id": "shopify-custom-access-token",
  "regex": "shpca_[a-fA-F0-9]{32}",
  "flags": "",
  "secretGroup": 0,
  "entropy": 2,
  "keywords": [
   "shpca_"
  ]
 },
 {
  "id": "shopify-private-app-access-token",
  "regex": "shppa_[a-fA-F0-9]{32}",
  "flags": "",
  "secretGroup": 0,
  "entropy": 2,
  "keywords": [
   "shppa_"
  ]
 },
 {
  "id": "shopify-shared-secret",
  "regex": "shpss_[a-fA-F0-9]{32}",
  "flags": "",
  "secretGroup": 0,
  "entropy": 2,
  "keywords": [
   "shpss_"
  ]
 },
 {
  "id": "sidekiq-secret",
  "regex": "[\\w.-]{0,50}?(?:BUNDLE_ENTERPRISE__CONTRIBSYS__COM|BUNDLE_GEMS__CONTRIBSYS__COM)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-f0-9]{8}:[a-f0-9]{8})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "bundle_enterprise__contribsys__com",
   "bundle_gems__contribsys__com"
  ]
 },
 {
  "id": "sidekiq-sensitive-url",
  "regex": "\\bhttps?://([a-f0-9]{8}:[a-f0-9]{8})@(?:gems.contribsys.com|enterprise.contribsys.com)(?:[\\/|\\#|\\?|:]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "gems.contribsys.com",
   "enterprise.contribsys.com"
  ]
 },
 {
  "id": "slack-app-token",
  "regex": "xapp-\\d-[A-Z0-9]+-\\d+-[a-z0-9]+",
  "flags": "i",
  "secretGroup": 0,
  "entropy": 2,
  "keywords": [
   "xapp"
  ]
 },
 {
  "id": "slack-bot-token",
  "regex": "xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*",
  "flags": "",
  "secretGroup": 0,
  "entropy": 3,
  "keywords": [
   "xoxb"
  ]
 },
 {
  "id": "slack-config-access-token",
  "regex": "xoxe.xox[bp]-\\d-[A-Z0-9]{163,166}",
  "flags": "i",
  "secretGroup": 0,
  "entropy": 2,
  "keywords": [
   "xoxe.xoxb-",
   "xoxe.xoxp-"
  ]
 },
 {
  "id": "slack-config-refresh-token",
  "regex": "xoxe-\\d-[A-Z0-9]{146}",
  "flags": "i",
  "secretGroup": 0,
  "entropy": 2,
  "keywords": [
   "xoxe-"
  ]
 },
 {
  "id": "slack-legacy-bot-token",
  "regex": "xoxb-[0-9]{8,14}-[a-zA-Z0-9]{18,26}",
  "flags": "",
  "secretGroup": 0,
  "entropy": 2,
  "keywords": [
   "xoxb"
  ]
 },
 {
  "id": "slack-legacy-token",
  "regex": "xox[os]-\\d+-\\d+-\\d+-[a-fA-F\\d]+",
  "flags": "",
  "secretGroup": 0,
  "entropy": 2,
  "keywords": [
   "xoxo",
   "xoxs"
  ]
 },
 {
  "id": "slack-legacy-workspace-token",
  "regex": "xox[ar]-(?:\\d-)?[0-9a-zA-Z]{8,48}",
  "flags": "",
  "secretGroup": 0,
  "entropy": 2,
  "keywords": [
   "xoxa",
   "xoxr"
  ]
 },
 {
  "id": "slack-user-token",
  "regex": "xox[pe](?:-[0-9]{10,13}){3}-[a-zA-Z0-9-]{28,34}",
  "flags": "",
  "secretGroup": 0,
  "entropy": 2,
  "keywords": [
   "xoxp-",
   "xoxe-"
  ]
 },
 {
  "id": "slack-webhook-url",
  "regex": "(?:https?://)?hooks.slack.com/(?:services|workflows|triggers)/[A-Za-z0-9+/]{43,56}",
  "flags": "",
  "secretGroup": 0,
  "entropy": 0,
  "keywords": [
   "hooks.slack.com"
  ]
 },
 {
  "id": "snyk-api-token",
  "regex": "[\\w.-]{0,50}?(?:snyk[_.-]?(?:(?:api|oauth)[_.-]?)?(?:key|token))(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "snyk"
  ]
 },
 {
  "id": "sonar-api-token",
  "regex": "[\\w.-]{0,50}?(?:sonar[_.-]?(login|token))(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}((?:squ_|sqp_|sqa_)?[a-z0-9=_\\-]{40})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 2,
  "entropy": 0,
  "keywords": [
   "sonar"
  ]
 },
 {
  "id": "sourcegraph-access-token",
  "regex": "\\b(\\b(sgp_(?:[a-fA-F0-9]{16}|local)_[a-fA-F0-9]{40}|sgp_[a-fA-F0-9]{40}|[a-fA-F0-9]{40})\\b)(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 3,
  "keywords": [
   "sgp_",
   "sourcegraph"
  ]
 },
 {
  "id": "square-access-token",
  "regex": "\\b((?:EAAA|sq0atp-)[\\w-]{22,60})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "",
  "secretGroup": 1,
  "entropy": 2,
  "keywords": [
   "sq0atp-",
   "eaaa"
  ]
 },
 {
  "id": "squarespace-access-token",
  "regex": "[\\w.-]{0,50}?(?:squarespace)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "squarespace"
  ]
 },
 {
  "id": "stripe-access-token",
  "regex": "\\b((?:sk|rk)_(?:test|live|prod)_[a-zA-Z0-9]{10,99})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "",
  "secretGroup": 1,
  "entropy": 2,
  "keywords": [
   "sk_test",
   "sk_live",
   "sk_prod",
   "rk_test",
   "rk_live",
   "rk_prod"
  ]
 },
 {
  "id": "sumologic-access-id",
  "regex": "[\\w.-]{0,50}?(?i:[\\w.-]{0,50}?(?:(?-i:[Ss]umo|SUMO))(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3})(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}(su[a-zA-Z0-9]{12})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "",
  "secretGroup": 1,
  "entropy": 3,
  "keywords": [
   "sumo"
  ]
 },
 {
  "id": "sumologic-access-token",
  "regex": "[\\w.-]{0,50}?(?:(?-i:[Ss]umo|SUMO))(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9]{64})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 3,
  "keywords": [
   "sumo"
  ]
 },
 {
  "id": "telegram-bot-api-token",
  "regex": "[\\w.-]{0,50}?(?:telegr)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([0-9]{5,16}:(?-i:A)[a-z0-9_\\-]{34})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "telegr"
  ]
 },
 {
  "id": "travisci-access-token",
  "regex": "[\\w.-]{0,50}?(?:travis)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9]{22})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "travis"
  ]
 },
 {
  "id": "twilio-api-key",
  "regex": "SK[0-9a-fA-F]{32}",
  "flags": "",
  "secretGroup": 0,
  "entropy": 3,
  "keywords": [
   "sk"
  ]
 },
 {
  "id": "twitch-api-token",
  "regex": "[\\w.-]{0,50}?(?:twitch)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9]{30})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "twitch"
  ]
 },
 {
  "id": "twitter-access-secret",
  "regex": "[\\w.-]{0,50}?(?:twitter)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9]{45})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "twitter"
  ]
 },
 {
  "id": "twitter-access-token",
  "regex": "[\\w.-]{0,50}?(?:twitter)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([0-9]{15,25}-[a-zA-Z0-9]{20,40})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "twitter"
  ]
 },
 {
  "id": "twitter-api-key",
  "regex": "[\\w.-]{0,50}?(?:twitter)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9]{25})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "twitter"
  ]
 },
 {
  "id": "twitter-api-secret",
  "regex": "[\\w.-]{0,50}?(?:twitter)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9]{50})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "twitter"
  ]
 },
 {
  "id": "twitter-bearer-token",
  "regex": "[\\w.-]{0,50}?(?:twitter)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}(A{22}[a-zA-Z0-9%]{80,100})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "twitter"
  ]
 },
 {
  "id": "typeform-api-token",
  "regex": "[\\w.-]{0,50}?(?:typeform)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}(tfp_[a-z0-9\\-_\\.=]{59})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "tfp_"
  ]
 },
 {
  "id": "vault-batch-token",
  "regex": "\\b(hvb\\.[\\w-]{138,300})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "",
  "secretGroup": 1,
  "entropy": 4,
  "keywords": [
   "hvb."
  ]
 },
 {
  "id": "vault-service-token",
  "regex": "\\b((?:hvs\\.[\\w-]{90,120}|s\\.(?i:[a-z0-9]{24})))(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "",
  "secretGroup": 1,
  "entropy": 3.5,
  "keywords": [
   "hvs.",
   "s."
  ]
 },
 {
  "id": "yandex-access-token",
  "regex": "[\\w.-]{0,50}?(?:yandex)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}(t1\\.[A-Z0-9a-z_-]+[=]{0,2}\\.[A-Z0-9a-z_-]{86}[=]{0,2})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "yandex"
  ]
 },
 {
  "id": "yandex-api-key",
  "regex": "[\\w.-]{0,50}?(?:yandex)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}(AQVN[A-Za-z0-9_\\-]{35,38})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "yandex"
  ]
 },
 {
  "id": "yandex-aws-access-token",
  "regex": "[\\w.-]{0,50}?(?:yandex)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}(YC[a-zA-Z0-9_\\-]{38})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "yandex"
  ]
 },
 {
  "id": "zendesk-secret-key",
  "regex": "[\\w.-]{0,50}?(?:zendesk)(?:[ \\t\\w.-]{0,20})[\\s'\"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'\"\\s=]{0,5}([a-z0-9]{40})(?:[\\x60'\"\\s;]|\\\\[nr]|$)",
  "flags": "i",
  "secretGroup": 1,
  "entropy": 0,
  "keywords": [
   "zendesk"
  ]
 }
];

/** Rules from the table that were left out because their regular expressions do not translate to JavaScript. */
export const skippedGitleaksRules: string[] = ["adobe-client-secret", "alibaba-access-key-id", "authress-service-client-access-key", "curl-auth-header", "doppler-api-token", "duffel-api-token", "dynatrace-api-token", "easypost-api-token", "easypost-test-api-token", "facebook-page-access-token", "flutterwave-encryption-key", "flutterwave-public-key", "flutterwave-secret-key", "frameio-api-token", "gocardless-api-token", "intra42-client-secret", "linear-api-key", "planetscale-api-token", "planetscale-password", "postman-api-token", "sendgrid-api-token", "sendinblue-api-token"];
