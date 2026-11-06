package com.microorganics.calltracker

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** WhatsApp-like colours for the conversation; the night variants follow the app's own light/dark scheme. */
internal class ChatColors(
    val background: Color,
    val incoming: Color,
    val outgoing: Color,
    val text: Color,
    val meta: Color,
    val readTick: Color,
    val chip: Color,
    val composer: Color,
)

@Composable
internal fun chatColors(): ChatColors {
    val dark = MaterialTheme.colorScheme.background.luminance() < 0.5f
    return if (dark) {
        ChatColors(Color(0xFF0B141A), Color(0xFF202C33), Color(0xFF005C4B), Color(0xFFE9EDEF), Color(0xFF8696A0), Color(0xFF53BDEB), Color(0xFF182229), Color(0xFF202C33))
    } else {
        ChatColors(Color(0xFFEFE7DD), Color.White, Color(0xFFD9FDD3), Color(0xFF111B21), Color(0xFF667781), Color(0xFF53BDEB), Color(0xFFFFFFFF), Color.White)
    }
}

/** A 48 dp icon button with a spoken description; [tint] defaults to the surrounding content colour. */
@Composable
internal fun IconAction(icon: Int, description: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, tint: Color = LocalContentColor.current) {
    IconButton(onClick = onClick, enabled = enabled, modifier = modifier.size(48.dp)) {
        Icon(painterResource(icon), contentDescription = description, tint = if (enabled) tint else tint.copy(alpha = 0.38f), modifier = Modifier.size(24.dp))
    }
}

/** Back icon, a heading and optional trailing actions. */
@Composable
internal fun ScreenTopBar(title: String, onBack: () -> Unit, actions: @Composable () -> Unit = {}) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        IconAction(R.drawable.ic_back, "Back", onBack)
        Text(
            title, Modifier.weight(1f).semantics { heading() }, style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
        actions()
    }
}

/** Circle with the customer's initials. */
@Composable
internal fun Avatar(name: String, size: Dp = 40.dp) {
    Box(
        Modifier.size(size).clip(CircleShape).background(MaterialTheme.colorScheme.primaryContainer),
        contentAlignment = Alignment.Center,
    ) {
        Text(initialsOf(name), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onPrimaryContainer)
    }
}

/** An icon with a label, as one tappable row of a bottom sheet. */
@Composable
internal fun SheetRow(icon: Int, label: String, onClick: () -> Unit, enabled: Boolean = true) {
    androidx.compose.material3.Surface(onClick = onClick, enabled = enabled, color = Color.Transparent, modifier = Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp).then(Modifier),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Box(Modifier.size(44.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primaryContainer), contentAlignment = Alignment.Center) {
                Icon(painterResource(icon), contentDescription = null, tint = MaterialTheme.colorScheme.onPrimaryContainer, modifier = Modifier.size(24.dp))
            }
            Text(label, style = MaterialTheme.typography.bodyLarge)
        }
    }
}
