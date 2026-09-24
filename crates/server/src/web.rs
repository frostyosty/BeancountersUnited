//! Serves the built web app (`apps/web/dist`) from inside the binary, so a release build is one
//! file. Only with the `embed-web` feature; build the web app first (`pnpm --filter web build`).
//! In development Vite serves the app instead and proxies `/api` here.

use axum::http::{StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use rust_embed::Embed;

#[derive(Embed)]
#[folder = "../../apps/web/dist"]
struct Dist;

/// Any path that isn't an API route: the file if there is one, else `index.html`, so the
/// app's own routes load it too. Unknown `/api` paths stay 404s.
pub async fn serve(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    if path == "api" || path.starts_with("api/") {
        return StatusCode::NOT_FOUND.into_response();
    }
    let (file, name) = match Dist::get(path) {
        Some(file) if !path.is_empty() => (file, path),
        _ => match Dist::get("index.html") {
            Some(file) => (file, "index.html"),
            None => return StatusCode::NOT_FOUND.into_response(),
        },
    };
    // Hashed asset names never change content; index.html must always be re-checked.
    let cache = if name.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    (
        [
            (header::CONTENT_TYPE, file.metadata.mimetype().to_owned()),
            (header::CACHE_CONTROL, cache.to_owned()),
        ],
        file.data,
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn get(path: &str) -> Response {
        serve(path.parse().unwrap()).await
    }

    #[tokio::test]
    async fn app_routes_get_index_and_api_paths_stay_404() {
        let index = get("/").await;
        assert_eq!(index.status(), StatusCode::OK);
        assert_eq!(index.headers()[header::CONTENT_TYPE], "text/html");
        assert_eq!(
            get("/clients/123").await.headers()[header::CACHE_CONTROL],
            "no-cache"
        );
        assert_eq!(get("/api/nope").await.status(), StatusCode::NOT_FOUND);
    }
}
