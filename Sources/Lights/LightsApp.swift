import SwiftUI

@main
struct LightsApp: App {
    var body: some Scene {
        WindowGroup {
            SimulatorView()
                .frame(minWidth: 760, minHeight: 520)
        }
        .windowResizability(.contentSize)
    }
}
