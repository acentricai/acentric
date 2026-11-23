//! Which authorities the daemon takes an engine's certificate to be signed by: Mozilla's, as
//! browsers do, and those this machine trusts besides, so that an engine behind a certificate of
//! an organisation's own authority is reached too:
//!
//! - on Linux, the certificates the distribution keeps for the whole machine, where an
//!   organisation's authority is installed (`update-ca-certificates`, `update-ca-trust`);
//! - on every system, those in the file `SSL_CERT_FILE` names, as for curl and OpenSSL.
//!
//! The daemon only ever talks to its engine: its connection, enrolling, and taking the engine's
//! build of itself all use these.

use std::sync::{Arc, OnceLock};

use rustls::pki_types::CertificateDer;
use rustls::pki_types::pem::PemObject as _;

/// Where Linux distributions keep the certificates the machine trusts. The first that is there
/// is read.
const SYSTEM_BUNDLES: &[&str] = &[
    // Debian, Ubuntu, Alpine, Arch.
    "/etc/ssl/certs/ca-certificates.crt",
    // Fedora, RHEL, CentOS.
    "/etc/pki/tls/certs/ca-bundle.crt",
    // openSUSE.
    "/etc/ssl/ca-bundle.pem",
];

/// The certificates of every authority the daemon trusts, read once.
pub fn roots() -> Result<&'static [CertificateDer<'static>], String> {
    static ROOTS: OnceLock<Result<Vec<CertificateDer<'static>>, String>> = OnceLock::new();
    ROOTS
        .get_or_init(|| {
            let file = std::env::var("SSL_CERT_FILE").ok();
            let system: &[&str] = if cfg!(target_os = "linux") {
                SYSTEM_BUNDLES
            } else {
                &[]
            };
            load(file.as_deref(), system)
        })
        .as_deref()
        .map_err(Clone::clone)
}

/// Mozilla's authorities, then the first of `system` that is there, then the file named.
fn load(file: Option<&str>, system: &[&str]) -> Result<Vec<CertificateDer<'static>>, String> {
    let mut roots: Vec<CertificateDer<'static>> = webpki_root_certs::TLS_SERVER_ROOT_CERTS
        .iter()
        .map(|cert| cert.clone().into_owned())
        .collect();
    // The machine's own: what of it can be read. One that is not there, or not certificates,
    // takes nothing away.
    let bundle = system
        .iter()
        .find(|path| std::path::Path::new(path).is_file());
    if let Some(Ok(certs)) = bundle.map(CertificateDer::pem_file_iter) {
        roots.extend(certs.filter_map(Result::ok));
    }
    // One that was named is meant: what is wrong with it is said.
    if let Some(path) = file.filter(|path| !path.is_empty()) {
        let certs: Vec<CertificateDer<'static>> = CertificateDer::pem_file_iter(path)
            .map_err(|error| format!("SSL_CERT_FILE is {path}, which could not be read: {error}"))?
            .collect::<Result<_, _>>()
            .map_err(|error| {
                format!("SSL_CERT_FILE is {path}, which is not certificates: {error}")
            })?;
        if certs.is_empty() {
            return Err(format!(
                "SSL_CERT_FILE is {path}, which has no certificate in it"
            ));
        }
        roots.extend(certs);
    }
    Ok(roots)
}

/// What a TLS connection to the engine is checked against.
pub fn root_store() -> Result<rustls::RootCertStore, String> {
    let mut store = rustls::RootCertStore::empty();
    // One the TLS library cannot take, such as an authority of an older kind, is left out.
    store.add_parsable_certificates(roots()?.iter().cloned());
    Ok(store)
}

/// An HTTP client for the engine, which says what it answered whatever its status.
pub fn agent() -> Result<ureq::Agent, String> {
    let certs: Vec<ureq::tls::Certificate<'static>> = roots()?
        .iter()
        .map(|cert| ureq::tls::Certificate::from_der(cert.as_ref()).to_owned())
        .collect();
    let tls = ureq::tls::TlsConfig::builder()
        .root_certs(ureq::tls::RootCerts::Specific(Arc::new(certs)))
        .build();
    Ok(ureq::Agent::config_builder()
        .http_status_as_error(false)
        .tls_config(tls)
        .build()
        .into())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_CA: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/test-ca.pem");

    fn mozilla() -> usize {
        webpki_root_certs::TLS_SERVER_ROOT_CERTS.len()
    }

    #[test]
    fn trusts_mozillas_authorities_alone_when_there_is_nothing_else() {
        let roots = load(None, &["/no/such/bundle.pem"]).unwrap();
        assert_eq!(roots.len(), mozilla());
        assert!(mozilla() > 100);
    }

    #[test]
    fn trusts_the_file_ssl_cert_file_names_too() {
        let roots = load(Some(TEST_CA), &[]).unwrap();
        assert_eq!(roots.len(), mozilla() + 1);
        assert_eq!(load(Some(""), &[]).unwrap().len(), mozilla());
    }

    #[test]
    fn trusts_the_first_system_bundle_there_is() {
        let roots = load(None, &["/no/such/bundle.pem", TEST_CA, TEST_CA]).unwrap();
        assert_eq!(roots.len(), mozilla() + 1);
    }

    #[test]
    fn says_what_is_wrong_with_a_file_that_was_named() {
        let missing = load(Some("/no/such/ca.pem"), &[]).unwrap_err();
        assert!(
            missing.contains("SSL_CERT_FILE is /no/such/ca.pem"),
            "{missing}"
        );
        let empty = std::env::temp_dir().join("acentric-machine-no-certificates.pem");
        std::fs::write(&empty, "not a certificate\n").unwrap();
        let none = load(Some(empty.to_str().unwrap()), &[]).unwrap_err();
        assert!(none.contains("has no certificate"), "{none}");
    }

    #[test]
    fn every_root_is_one_the_tls_library_takes() {
        let mut store = rustls::RootCertStore::empty();
        let (added, _) = store.add_parsable_certificates(load(Some(TEST_CA), &[]).unwrap());
        assert_eq!(added, mozilla() + 1);
    }
}
