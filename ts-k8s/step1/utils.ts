import * as digitalocean from "@pulumi/digitalocean";
import * as pulumi from "@pulumi/pulumi";
import * as fs from "fs";
import * as k8s from "@pulumi/kubernetes";
import * as childProcess from "child_process";
import * as tmp from "tmp";

// Manufacture a DO kubeconfig that uses a given API token.
//
// Note: this is slightly "different" than the default DOKS kubeconfig created
// for the cluster admin, which uses a new token automatically created by DO.
export function createTokenKubeconfig(
    cluster: digitalocean.KubernetesCluster,
    user: pulumi.Input<string>,
    apiToken: pulumi.Input<string>,
): pulumi.Output<any> {
    return pulumi.interpolate`apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: ${cluster.kubeConfigs[0].clusterCaCertificate}
    server: ${cluster.endpoint}
  name: ${cluster.name}
contexts:
- context:
    cluster: ${cluster.name}
    user: ${cluster.name}-${user}
  name: ${cluster.name}
current-context: ${cluster.name}
kind: Config
users:
- name: ${cluster.name}-${user}
  user:
    token: ${apiToken}
`;
}

// Manufacture a DO kubeconfig that uses a given client certificate and key.
//
// Note: this is slightly "different" than the default DOKS kubeconfig created
// for the cluster admin, which uses a new token automatically created by DO.
export function createCertKubeconfig(
    cluster: digitalocean.KubernetesCluster,
    user: pulumi.Input<string>,
    certFilepath: pulumi.Input<string>,
    keyFilepath: pulumi.Input<string>,
): pulumi.Output<any> {
    pulumi.all([certFilepath, keyFilepath]).apply(([certFp, keyFp]) => {
        if (!fs.existsSync(certFp) || !fs.existsSync(keyFp)) {
            throw new Error ("Cert and/or key filepaths does not exist at: " +
                `certFilepath: ${certFp} | keyFilepath:${keyFp}`);
        }
    });
    return pulumi.interpolate`apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: ${cluster.kubeConfigs[0].clusterCaCertificate}
    server: ${cluster.endpoint}
  name: ${cluster.name}
contexts:
- context:
    cluster: ${cluster.name}
    user: ${cluster.name}-${user}
  name: ${cluster.name}
current-context: ${cluster.name}
kind: Config
users:
- name: ${cluster.name}-${user}
  user:
    client-certificate: ${certFilepath}
    client-key: ${keyFilepath}
`;
}

interface CertSigningRequestArgs {
    // Filepath of the CSR.
    csrFilepath: string,
    // Filepath to use when writing out the certificate.
    certFilepath: string,
    // Kubernetes cluster kubeconfig to issue certificate 
    kubeconfig: pulumi.Output<any>,
}

// createClientCert issues a CertificateSigningRequest to Kubernetes, and
// writes the cert out locally if it is approved.
export async function createClientCert(
    name: string,
    args: CertSigningRequestArgs,
): Promise<pulumi.Output<string>> {
    // Only issue a CSR if the cert does not already exist locally.
    if (fs.existsSync(args.certFilepath)) {
        return pulumi.output(args.certFilepath);
    }

    // Create a k8s provider.
    const k8sProvider = new k8s.Provider("k8s-csr", { kubeconfig: args.kubeconfig });

    // Issue the CSR to the k8s cluster and approve it.
    const csrData = fs.readFileSync(args.csrFilepath);
    const csrStr = csrData.toString()
    const csrB64 = Buffer.from(csrStr).toString("base64");
    const csr = new k8s.certificates.v1beta1.CertificateSigningRequest(name, {
        spec: {
            groups: [ "system:authenticated" ],
            request: csrB64,
            usages: [
                "digital signature",
                "key encipherment",
                "server auth",
                "client auth",
            ]
        },
    }, {provider: k8sProvider});

    // Call kubectl to approve the CSR since there is currently no means to
    // approve CSRs in p/k8s.
    csr.metadata.name.apply(csrName => {
        args.kubeconfig.apply(kc => {
            // Write the kubeconfig to a file.
            const tmpKubeconfig = tmp.fileSync();
            fs.writeFileSync(tmpKubeconfig.fd, kc);
            childProcess.execSync(`kubectl --kubeconfig ${tmpKubeconfig.name} certificate approve ${csrName}`)
        })
    });

    // Read the CSR status after it's been approved to extract the cert and
    // write it locally.
    const req = k8s.certificates.v1beta1.CertificateSigningRequest.get(`csr-${name}-read`,
        csr.metadata.name,
        {provider: k8sProvider},
    );

    // Write the cert locally, iff the CSR was approved and the cert exists.
    const certFp = req.status.apply(async status => {
        if (status?.conditions?.[0].type == "Approved") {
            console.log("Certificate signing request approved");
            const cert = Buffer.from(status.certificate, "base64").toString("utf-8");
            fs.writeFileSync(args.certFilepath, cert);
        }

        if(!fs.existsSync(args.certFilepath)){
            throw new Error("Client certificate does not exist at: " + args.certFilepath);
        }
        return args.certFilepath;
    })
    return certFp;
}

// UserNsRole is a k8s role, and it's binding of a user to a namespace.
interface UserNsRole {
    role: k8s.rbac.v1.Role;
    roleBinding: k8s.rbac.v1.RoleBinding;
}

// UserNsRole is the options to bind a user to a given role for a namespace.
interface UserNsRoleArgs {
    user: pulumi.Input<string>,
    namespace: pulumi.Input<string>,
    provider: k8s.Provider,
}

// Create a k8s role for a user to work in a namespace.
export function createUserNsRole(
    name: string,
    args: UserNsRoleArgs,
): UserNsRole {
    const userRole = new k8s.rbac.v1.Role(`${name}`, {
        metadata: {namespace: args.namespace},
        rules: [
            {
                apiGroups: [""],
                resources: ["configmaps", "pods", "secrets", "endpoints", "services", "persistentvolumeclaims"],
                verbs: ["get", "list", "watch", "create", "patch", "update", "delete"],
            },
            {
                apiGroups: ["rbac.authorization.k8s.io"],
                resources: ["clusterrole", "clusterrolebinding", "role", "rolebinding"],
                verbs: ["get", "list", "watch", "create", "patch", "update", "delete"],
            },
            {
                apiGroups: ["extensions", "apps"],
                resources: ["replicasets", "deployments"],
                verbs: ["get", "list", "watch", "create", "patch","update", "delete"],
            },
        ],
    },{provider: args.provider});

    // Bind the devs RBAC group to the new, limited role.
    const userRoleBinding = new k8s.rbac.v1.RoleBinding(`${name}`, {
        metadata: {namespace: args.namespace},
        subjects: [{
            kind: "User",
            name: args.user,
        }],
        roleRef: {
            apiGroup: "rbac.authorization.k8s.io",
            kind: "Role",
            name: userRole.metadata.name,
        },
    },{provider: args.provider});

    return <UserNsRole>{
        role: userRole,
        roleBinding: userRoleBinding,
    }
}
