import SwiftUI

struct SimulatorView: View {
    private let client = PreviewServerClient()
    private let device = "eaves"
    private let fps = 24
    private let clipDuration = 4.0

    @State private var scenes: [SceneMeta] = []
    @State private var selectedSceneId: String?
    @State private var positions: [LedPositionDTO] = []
    @State private var frames: FramesResponse?
    @State private var currentFrame = 0
    @State private var errorMessage: String?
    @State private var isLoading = false
    @State private var playbackTask: Task<Void, Never>?

    var body: some View {
        VStack(spacing: 0) {
            Canvas { context, size in
                let backdrop = Path(CGRect(origin: .zero, size: size))
                context.fill(backdrop, with: .linearGradient(
                    Gradient(colors: [Color(red: 0.03, green: 0.04, blue: 0.09), Color(red: 0.08, green: 0.1, blue: 0.18)]),
                    startPoint: .zero, endPoint: CGPoint(x: 0, y: size.height)
                ))

                guard let colors = frames?.frames[safe: currentFrame]?.colors, colors.count == positions.count else { return }

                for (i, pos) in positions.enumerated() {
                    let c = colors[i]
                    let color = Color(red: Double(c[0]) / 255, green: Double(c[1]) / 255, blue: Double(c[2]) / 255)
                    let center = CGPoint(x: pos.x * size.width, y: pos.y * size.height)
                    let brightness = (Double(c[0]) + Double(c[1]) + Double(c[2])) / 765

                    if brightness > 0.05 {
                        let glowRect = CGRect(x: center.x - 7, y: center.y - 7, width: 14, height: 14)
                        context.opacity = 0.35 * brightness
                        context.fill(Path(ellipseIn: glowRect), with: .color(color))
                    }

                    context.opacity = 1
                    let dotRect = CGRect(x: center.x - 2.5, y: center.y - 2.5, width: 5, height: 5)
                    context.fill(Path(ellipseIn: dotRect), with: .color(color))
                }
            }
            .aspectRatio(4.0 / 3.0, contentMode: .fit)
            .background(Color.black)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .padding()
            .overlay {
                if let errorMessage {
                    ContentUnavailableView("Simulator Unavailable", systemImage: "wifi.slash", description: Text(errorMessage))
                        .padding()
                } else if isLoading {
                    ProgressView()
                }
            }

            Divider()

            HStack {
                Picker("Scene", selection: $selectedSceneId) {
                    ForEach(scenes) { scene in
                        Text(scene.name).tag(Optional(scene.id))
                    }
                }
                .frame(maxWidth: 260)
                .onChange(of: selectedSceneId) { _, _ in
                    Task { await loadFrames() }
                }

                if let scene = scenes.first(where: { $0.id == selectedSceneId }) {
                    Text(scene.description)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }

                Spacer()

                Button {
                    Task { await reload() }
                } label: {
                    Label("Reload", systemImage: "arrow.clockwise")
                }
            }
            .padding()
        }
        .task { await reload() }
        .onDisappear { playbackTask?.cancel() }
    }

    private func reload() async {
        isLoading = true
        errorMessage = nil
        do {
            async let sceneList = client.scenes()
            async let map = client.coordinateMap(device: device)
            scenes = try await sceneList
            positions = try await map.positions
            if selectedSceneId == nil { selectedSceneId = scenes.first?.id }
            await loadFrames()
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    private func loadFrames() async {
        guard let sceneId = selectedSceneId else { return }
        playbackTask?.cancel()
        do {
            let result = try await client.frames(device: device, sceneId: sceneId, duration: clipDuration, fps: fps)
            frames = result
            currentFrame = 0
            startPlayback(frameCount: result.frameCount)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func startPlayback(frameCount: Int) {
        guard frameCount > 0 else { return }
        playbackTask = Task {
            let interval = UInt64(1_000_000_000 / fps)
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: interval)
                if Task.isCancelled { return }
                currentFrame = (currentFrame + 1) % frameCount
            }
        }
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
