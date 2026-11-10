#!/bin/bash
# A throwaway OpenLDAP server that looks enough like Active Directory to test
# the real LDAP provider against. Needs `slapd` and `openssl` (apt install slapd).
#
#   scripts/dev-ldap/run.sh start <workdir>   # starts ldap://:3890 and ldaps://:6360
#   scripts/dev-ldap/run.sh stop  <workdir>
#
# It writes a CA to <workdir>/ca.pem; point AD_TLS_CA at it. NOT Active
# Directory: it has no real group semantics, no lockout, no nested-group rule.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CMD="${1:-start}"; DIR="${2:?give a working directory}"
mkdir -p "$DIR"

if [ "$CMD" = "stop" ]; then
  [ -f "$DIR/slapd.pid" ] && kill "$(cat "$DIR/slapd.pid")" 2>/dev/null || true
  exit 0
fi

SLAPD="$(command -v slapd || echo /usr/sbin/slapd)"
SCHEMA=/etc/ldap/schema

if [ ! -f "$DIR/server.pem" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=Test CA" -keyout "$DIR/ca.key" -out "$DIR/ca.pem" 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" -keyout "$DIR/server.key" -out "$DIR/server.csr" 2>/dev/null
  printf "subjectAltName=DNS:localhost,IP:127.0.0.1" > "$DIR/san.ext"
  openssl x509 -req -in "$DIR/server.csr" -CA "$DIR/ca.pem" -CAkey "$DIR/ca.key" -CAcreateserial -days 30 -extfile "$DIR/san.ext" -out "$DIR/server.pem" 2>/dev/null
fi

rm -rf "$DIR/db"; mkdir -p "$DIR/db"
# Debian/Ubuntu build the database backends as loadable modules.
MODPATH=""
for d in /usr/lib/ldap /usr/lib/openldap /usr/lib64/openldap; do [ -d "$d" ] && MODPATH="$d" && break; done
cat > "$DIR/slapd.conf" <<CONF
${MODPATH:+modulepath $MODPATH
moduleload back_mdb}
include $SCHEMA/core.schema
include $SCHEMA/cosine.schema
include $SCHEMA/inetorgperson.schema
include $HERE/ad-like.schema
pidfile $DIR/slapd.pid
TLSCACertificateFile $DIR/ca.pem
TLSCertificateFile $DIR/server.pem
TLSCertificateKeyFile $DIR/server.key
database mdb
maxsize 10485760
suffix "dc=city,dc=test"
rootdn "cn=admin,dc=city,dc=test"
rootpw AdminPass#1
directory $DIR/db
index objectClass eq
CONF
"$SLAPD" -f "$DIR/slapd.conf" -h "ldap://127.0.0.1:3890 ldaps://127.0.0.1:6360" -u root -g root >"$DIR/slapd.log" 2>&1 &
sleep 1
# Load the seed (with the daemon down this would use slapadd; with it up, ldapadd).
ldapadd -x -H ldap://127.0.0.1:3890 -D "cn=admin,dc=city,dc=test" -w 'AdminPass#1' -f "$HERE/seed.ldif" >/dev/null
echo "LDAP ready: ldap://127.0.0.1:3890  ldaps://127.0.0.1:6360  CA: $DIR/ca.pem"
