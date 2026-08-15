import Foundation

struct SceneMeta: Decodable, Identifiable {
    let id: String
    let name: String
    let description: String
}

struct LedPositionDTO: Decodable {
    let run: String
    let segment: Int
    let index: Int
    let deviceIndex: Int
    let x: Double
    let y: Double
}

struct CoordinateMapResponse: Decodable {
    let device: String
    let referenceImage: String?
    let positions: [LedPositionDTO]
}

struct FrameDTO: Decodable {
    let tSeconds: Double
    let colors: [[Int]]
}

struct FramesResponse: Decodable {
    let scene: String
    let device: String
    let fps: Int
    let frameCount: Int
    let frames: [FrameDTO]
}
