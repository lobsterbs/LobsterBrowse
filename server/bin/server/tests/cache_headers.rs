use axum::body::Body;
use axum::http::{header, HeaderValue, Request, StatusCode};
use axum::routing::get;
use axum::Router;
use tower::ServiceExt;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;

/* w80 regression: the UI tree is served by a bare ServeDir, which sends
 * no Cache-Control, so browsers heuristically cached index.html across
 * deploys and users kept seeing the previous UI after a wave shipped.
 * The SPA shell and every non-hashed UI file must revalidate (no-cache);
 * the content-hashed /assets tree is content-addressed and may be cached
 * immutable. Ordinary API routes are untouched. */
#[tokio::test]
async fn spa_tree_cache_control_headers() {
    let tmp = std::env::temp_dir().join(format!("lb-w80-test-{}", std::process::id()));
    let assets_dir = tmp.join("assets");
    std::fs::create_dir_all(&assets_dir).unwrap();
    std::fs::write(tmp.join("index.html"), "<html>w80</html>").unwrap();
    std::fs::write(assets_dir.join("app-abc123.css"), "body{}").unwrap();

    let send = |uri: &str| Request::builder().uri(uri).body(Body::empty()).unwrap();

    let assets = tower::ServiceBuilder::new()
        .layer(SetResponseHeaderLayer::overriding(
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=31536000, immutable"),
        ))
        .service(ServeDir::new(assets_dir.clone()));
    let ui = tower::ServiceBuilder::new()
        .layer(SetResponseHeaderLayer::overriding(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-cache"),
        ))
        .service(
            ServeDir::new(tmp.clone())
                .append_index_html_on_directories(true)
                .not_found_service(ServeFile::new(tmp.join("index.html"))),
        );
    let app = Router::new()
        .route("/zl", get(|| async { "ok" }))
        .nest_service("/assets", assets)
        .fallback_service(ui);

    /* index.html: revalidate on every load so deploys land. */
    let res = app.clone().oneshot(send("/")).await.unwrap();
    assert_eq!(
        res.headers().get(header::CACHE_CONTROL).unwrap(),
        "no-cache"
    );
    assert_eq!(res.status(), StatusCode::OK);

    /* Hashed asset: immutable. */
    let res = app
        .clone()
        .oneshot(send("/assets/app-abc123.css"))
        .await
        .unwrap();
    assert_eq!(
        res.headers().get(header::CACHE_CONTROL).unwrap(),
        "public, max-age=31536000, immutable"
    );
    assert_eq!(res.status(), StatusCode::OK);

    /* Ordinary routes keep working without the static-tree headers. */
    let res = app.clone().oneshot(send("/zl")).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers().get(header::CACHE_CONTROL), None);

    /* Missing asset: plain 404 (hashed names make this a stale shell),
     * not the SPA shell. */
    let res = app.clone().oneshot(send("/assets/nope.css")).await.unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);

    /* Missing non-asset path: same 404 the bare ServeDir produced before
     * w80 (the app never used path-based SPA routes), now revalidating. */
    let res = app.oneshot(send("/settings")).await.unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        res.headers().get(header::CACHE_CONTROL).unwrap(),
        "no-cache"
    );

    std::fs::remove_dir_all(&tmp).ok();
}
