/** @typedef {import('pear-interface')} */ /* global Pear */

import Hyperswarm from 'hyperswarm';
import b4a from 'b4a';

const directoryPickerButton = document.getElementById('select-directory');
const directoryTreeContainer = document.createElement('div');
directoryTreeContainer.id = 'directory-tree';
document.body.appendChild(directoryTreeContainer);

const directoryHandles = new Map(); // Store handles for shared directories
let currentPath = '/'; // Track the current path for navigation

const swarm = new Hyperswarm();
Pear.teardown(() => swarm.destroy());

// Keep track of all connections and console.log incoming data
const conns = [];
swarm.on('connection', conn => {
  const name = b4a.toString(conn.remotePublicKey, 'hex');
  console.log('* got a connection from:', name, '*');
  conns.push(conn);
  conn.once('close', () => conns.splice(conns.indexOf(conn), 1));
  conn.on('data', data => handleIncomingData(data, conn, name));
  conn.on('error', e => console.log(`Connection error: ${e}`));
});

directoryPickerButton.addEventListener('click', async () => {
  const directoryHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
  directoryHandles.set('/', directoryHandle); // Store the root directory with key "/"
  currentPath = '/'; // Reset to root
  await listFiles(directoryHandle, '/');
});

async function listFiles(directoryHandle, path) {
  const items = [];
  for await (const entry of directoryHandle.values()) {
    items.push({
      name: entry.name,
      kind: entry.kind,
      type: entry.kind === 'directory' ? 'directory' : entry.type,
      path: path + entry.name + (entry.kind === 'directory' ? '/' : ''), // Maintain a path for nested dirs
    });

    // If the entry is a directory, store its handle for later access
    if (entry.kind === 'directory') {
      const subDirHandle = await directoryHandle.getDirectoryHandle(entry.name);
      directoryHandles.set(path + entry.name + '/', subDirHandle);
    }
  }

  const msg = {
    type: 'dir_enum',
    items: items,
    currentPath: path,
  };

  for (const conn of conns) {
    conn.write(JSON.stringify(msg));
  }
}

function handleIncomingData(data, conn, name) {
  try {
    const message = JSON.parse(data);
    if (message.type === 'dir_enum') {
      console.log(`Received directory listing from ${name}:`, message.items);
      renderDirectoryTree(message.items, message.currentPath, conn);
    } else if (message.type === 'dir_request') {
      // If a directory request is received, list its contents
      handleDirectoryRequest(message.path, conn);
    }
  } catch (e) {
    console.error(`Failed to process message from ${name}:`, e);
  }
}

function renderDirectoryTree(items, path, conn, container = directoryTreeContainer) {
  container.innerHTML = ''; // Clear existing tree

  // Add "Go Up" option if not in the root directory
  if (path !== '/') {
    const goUpLi = document.createElement('li');
    goUpLi.textContent = '.. (Go Up)';
    goUpLi.style.cursor = 'pointer';
    goUpLi.addEventListener('click', () => {
      const parentPath = path.slice(0, path.lastIndexOf('/', path.length - 2) + 1); // Calculate parent path
      conn.write(JSON.stringify({ type: 'dir_request', path: parentPath }));
    });
    container.appendChild(goUpLi);
  }

  const ul = document.createElement('ul');

  items.forEach(item => {
    const li = document.createElement('li');
    li.textContent = `${item.name} (${item.kind})`;

    // If the item is a directory, add click event to fetch its contents
    if (item.kind === 'directory') {
      li.style.cursor = 'pointer';
      li.addEventListener('click', () => {
        conn.write(JSON.stringify({ type: 'dir_request', path: item.path }));
      });
    }

    ul.appendChild(li);
  });

  container.appendChild(ul);
}

async function handleDirectoryRequest(path, conn) {
  // Get the handle of the requested directory
  const directoryHandle = directoryHandles.get(path);
  if (!directoryHandle) {
    console.error('Directory handle not found for path:', path);
    return;
  }

  const subItems = [];
  for await (const subEntry of directoryHandle.values()) {
    subItems.push({
      name: subEntry.name,
      kind: subEntry.kind,
      type: subEntry.kind === 'directory' ? 'directory' : subEntry.type,
      path: path + subEntry.name + (subEntry.kind === 'directory' ? '/' : ''),
    });

    // Store the handle for nested directories
    if (subEntry.kind === 'directory') {
      const subDirHandle = await directoryHandle.getDirectoryHandle(subEntry.name);
      directoryHandles.set(path + subEntry.name + '/', subDirHandle);
    }
  }

  currentPath = path; // Update current path

  const msg = {
    type: 'dir_enum',
    items: subItems,
    currentPath: path,
  };
  conn.write(JSON.stringify(msg));
}

// Join a common topic
const topic = Buffer.alloc(32).fill('p2p-fm');
const discovery = swarm.join(topic, { client: true, server: true });

// The flushed promise will resolve when the topic has been fully announced to the DHT
discovery.flushed().then(() => {
  console.log('joined topic:', b4a.toString(topic, 'hex'));
});
