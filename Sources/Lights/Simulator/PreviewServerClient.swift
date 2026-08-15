import Foundation

enum PreviewServerError: LocalizedError {
    case unreachable
    case http(Int, String)

    var errorDescription: String? {
        switch self {
        case .unreachable:
            return "Can't reach the preview server on localhost:8787. Run `npm run preview` in mcp-server/ first."
        case .http(let status, let body):
            return "Preview server returned HTTP \(status): \(body)"
        }
    }
}

actor PreviewServerClient {
    private let baseURL = URL(string: "http://localhost:8787")!

    private func get<T: Decodable>(_ path: String, query: [String: String] = [:]) async throws -> T {
        var components = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty {
            components.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await URLSession.shared.data(from: components.url!)
        } catch {
            throw PreviewServerError.unreachable
        }
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw PreviewServerError.http(status, String(data: data, encoding: .utf8) ?? "")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    func scenes() async throws -> [SceneMeta] {
        try await get("/scenes")
    }

    func coordinateMap(device: String) async throws -> CoordinateMapResponse {
        try await get("/coordinate-map", query: ["device": device])
    }

    func frames(device: String, sceneId: String, duration: Double, fps: Int) async throws -> FramesResponse {
        try await get(
            "/scenes/\(sceneId)/frames",
            query: ["device": device, "duration": String(duration), "fps": String(fps)]
        )
    }
}
