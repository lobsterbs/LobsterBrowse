export default function HomePage() {
  return (
    <section>
      <p style={{ fontSize: 18 }}>Free, private, fast web proxy with built-in ad blocking.</p>
      <label htmlFor="url" style={{ display: "block", fontWeight: 600 }}>Enter a URL</label>
      <input
        id="url"
        placeholder="example.com"
        style={{
          width: "100%", padding: "12px 16px",
          borderRadius: 28, border: "1px solid var(--md-sys-outline)",
          background: "transparent", color: "inherit", fontSize: 16,
        }}
      />
      <p style={{ opacity: 0.8, fontSize: 14 }}>
        Server: Rust Wisp v2.1 &#183; Filtering: uBlock lists &#183; Zero logging.
      </p>
    </section>
  );
}
