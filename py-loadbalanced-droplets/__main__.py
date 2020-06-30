""" This stack deploys 3 droplets behind a load balancer. """
import pulumi_digitalocean as do
from pulumi import export, Output, Config

DROPLET_COUNT = 3

config = Config()
region = config.require("region")

userdata = """#!/bin/bash
  sudo apt-get update
  sudo apt-get install -y nginx
"""

droplet_type_tag = do.Tag("demo-app")

for replica in range(0, DROPLET_COUNT):
    instance_name = "web-%s" % replica
    name_tag = do.Tag(instance_name)
    do.Droplet(
        instance_name,
        image="ubuntu-20-04-x64",
        region=region,
        size="512mb",
        tags=[name_tag.id, droplet_type_tag.id],
        user_data=userdata,
    )

loadbalancer = do.LoadBalancer(
    "public",
    droplet_tag=droplet_type_tag.name,
    forwarding_rules=[{
        "entry_port": 80,
        "entry_protocol": "http",
        "target_port": 80,
        "target_protocol": "http",
    }],
    healthcheck={
        "port": 80,
        "protocol": "tcp",
    },
    region=region,
)

endpoint = Output.concat("http://", loadbalancer.ip)
export("endpoint", endpoint)
