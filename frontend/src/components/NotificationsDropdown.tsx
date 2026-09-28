import React, { useState } from 'react';

interface Notification {
  id: string;
  title: string;
  message: string;
  read: boolean;
  time: string;
}

export const NotificationsDropdown: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([
    {
      id: 'n1',
      title: 'Report Approved',
      message: 'Your report for Site A was approved.',
      read: false,
      time: '10 mins ago'
    },
    {
      id: 'n2',
      title: 'New Comment',
      message: 'Alice commented on your photo.',
      read: false,
      time: '1 hour ago'
    },
    {
      id: 'n3',
      title: 'System Update',
      message: 'Scheduled maintenance this weekend.',
      read: true,
      time: '1 day ago'
    }
  ]);

  const unreadCount = notifications.filter(n => !n.read).length;

  const toggleDropdown = () => setIsOpen(!isOpen);

  const markAsRead = (id: string) => {
    setNotifications(notifications.map(n => n.id === id ? { ...n, read: true } : n));
  };

  return (
    <div className="notifications-dropdown" style={{ position: 'relative', display: 'inline-block' }}>
      <button 
        onClick={toggleDropdown}
        style={{ background: 'none', border: 'none', cursor: 'pointer', position: 'relative', fontSize: '24px' }}
      >
        🔔
        {unreadCount > 0 && (
          <span style={{
            position: 'absolute',
            top: '-5px',
            right: '-5px',
            backgroundColor: 'red',
            color: 'white',
            borderRadius: '50%',
            padding: '2px 6px',
            fontSize: '12px',
            fontWeight: 'bold'
          }}>
            {unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div style={{
          position: 'absolute',
          right: 0,
          top: '40px',
          width: '300px',
          backgroundColor: 'white',
          boxShadow: '0 4px 8px rgba(0,0,0,0.1)',
          borderRadius: '4px',
          border: '1px solid #ddd',
          zIndex: 1000
        }}>
          <div style={{ padding: '12px', borderBottom: '1px solid #ddd', fontWeight: 'bold' }}>
            Notifications
          </div>
          <div style={{ maxHeight: '300px', overflowY: 'auto' }}>
            {notifications.length === 0 ? (
              <div style={{ padding: '12px', textAlign: 'center', color: '#666' }}>No notifications</div>
            ) : (
              notifications.map(notification => (
                <div 
                  key={notification.id}
                  style={{
                    padding: '12px',
                    borderBottom: '1px solid #eee',
                    backgroundColor: notification.read ? 'white' : '#f0f8ff',
                    cursor: 'pointer'
                  }}
                  onClick={() => markAsRead(notification.id)}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                    <strong style={{ fontSize: '14px' }}>{notification.title}</strong>
                    <span style={{ fontSize: '12px', color: '#888' }}>{notification.time}</span>
                  </div>
                  <div style={{ fontSize: '13px', color: '#444' }}>
                    {notification.message}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};
