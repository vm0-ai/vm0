import Foundation

/// Decides which of the system's windows the picker may offer.
///
/// The recorder reads every Space rather than only the active one, so a
/// full-screen editor or browser is offerable too. That wider read also carries
/// the system's own surfaces — menu bar extras, the Dock, notification banners —
/// which are never what someone means to record. They sit above the normal
/// window layer, and that is what separates them here.
public enum RecordableWindowPolicy {
    /// The layer ordinary application windows live on. Everything the system
    /// floats above them — status items, the Dock, banners — is numbered higher.
    public static let applicationWindowLayer = 0

    /// Whether a window belongs in the picker.
    ///
    /// An untitled window is refused as well: the picker labels each choice with
    /// its title, and a nameless tile is worse than one fewer choice.
    public static func isRecordable(title: String?, windowLayer: Int) -> Bool {
        guard let title, !title.isEmpty else {
            return false
        }
        return windowLayer == applicationWindowLayer
    }
}
