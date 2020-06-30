#!/bin/bash

# Create a Certificate Signing Request (CSR)
# Based on https://do.co/2BzwfTe

NAME=$1
DIR=$2

if [ $# -lt 2 ]; then
    echo "Usage: $0 <key_name> <certs_dir>"
    exit 1
fi

# Create a private key.
openssl genrsa -out $DIR/$NAME.key 4096

# Create a CSR config file.
cat > $DIR/$NAME.csr.cnf << EOF
[ req ]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
[ dn ]
CN = $NAME
O = $NAME
[ v3_ext ]
authorityKeyIdentifier=keyid,issuer:always
basicConstraints=CA:FALSE
keyUsage=keyEncipherment,dataEncipherment
extendedKeyUsage=serverAuth,clientAuth
EOF

# Create a CSR.
openssl req -config $DIR/$NAME.csr.cnf -new -key $DIR/$NAME.key -nodes -out $DIR/$NAME.csr
